import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  addDiagnosticLog,
  type DeliveryKind,
  dropScheduledDeliveries,
  type EnabledReminder,
  getCatchupClaim,
  getEnabledReminders,
  getOverdueReminders,
  incrementEntry,
  markDeliveryActed,
  markDeliveryDelivered,
  recordExpectedDelivery,
  setReminderNotificationId,
  sweepUnconfirmedDeliveries,
} from './database';
import { appendFileLog, getReliabilityStatus, getScheduledAlarmLiveness, isReliabilityModuleAvailable, type ReliabilityStatus } from '../modules/habbitdot-reliability';

// Android channel sound/importance cannot be upgraded after creation. Keep the
// version in the ID so existing installs receive reliability improvements.
const CHANNEL_ID = 'important-habit-reminders-v2';
/** Exported so the UI can deep-link straight to this channel's Android settings page. */
export const REMINDER_CHANNEL_ID = CHANNEL_ID;
const CATEGORY_ID = 'habit_reminder';
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const REMINDER_KIND = 'habbitdot-reminder';
const ACCENT_COLOR = '#B7F171';

export type NotificationIssue =
  | 'permission-denied'
  | 'channel-disabled'
  | 'exact-alarms-blocked'
  | 'alarms-missing'
  | 'alarms-repaired'
  | 'scheduling-failed'
  | 'battery-optimized';

export type NotificationHealth = {
  /** True only when reminders will arrive, and arrive at the minute they were set for. */
  ready: boolean;
  scheduled: number;
  expected: number;
  liveAlarms: number | null;
  repairedAlarms: number;
  issues: NotificationIssue[];
  /** The most severe issue, so older call sites keep working unchanged. */
  issue?: NotificationIssue;
  exactAlarms: boolean | null;
  batteryOptimized: boolean | null;
  device: ReliabilityStatus | null;
};

/**
 * Ordered worst-first. `exact-alarms-blocked` sits high because it is silent: everything
 * reports as scheduled while expo-notifications quietly downgrades to an inexact alarm
 * that Android may batch, jitter or defer past the moment the dose was due.
 */
const ISSUE_SEVERITY: NotificationIssue[] = ['permission-denied', 'channel-disabled', 'exact-alarms-blocked', 'alarms-missing', 'scheduling-failed', 'alarms-repaired', 'battery-optimized'];

const isReminderNotification = (data: unknown): data is { kind: string; reminderId?: number; habitId?: number; deliveryKind?: DeliveryKind; occurrenceDate?: string } =>
  typeof data === 'object' && data !== null && typeof (data as { kind?: unknown }).kind === 'string' && (data as { kind: string }).kind.startsWith('habbitdot-');

const localDateKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Absolute instant of a local wall-clock time, `dayOffset` days from today. */
function occurrenceAt(hour: number, minute: number, dayOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

/** The next time a daily reminder is due: today if it is still ahead, otherwise tomorrow. */
function nextDailyOccurrence(hour: number, minute: number) {
  const today = occurrenceAt(hour, minute);
  return today.getTime() > Date.now() ? today : occurrenceAt(hour, minute, 1);
}

const primaryId = (reminderId: number) => `habit-reminder-${reminderId}`;
const datedPrimaryId = (reminderId: number, date: Date) => `habit-reminder-${reminderId}-${localDateKey(date)}`;
/** How far ahead dated one-off alarms are armed. Every reconcile tops the window back up. */
const ROLLING_HORIZON_DAYS = 14;
const followupId = (reminderId: number, index: number, date: Date) =>
  `habit-reminder-${reminderId}-nag${index}-${localDateKey(date)}`;

/**
 * Whether a reminder still needs the user's attention today. Follow-up nags are
 * suppressed against this rather than being unscheduled: the alarm must keep existing
 * for tomorrow even on days the app is never opened.
 */
const isSatisfied = (reminder: Pick<EnabledReminder, 'todayCount' | 'dailyGoal' | 'habitType'>) => reminder.todayCount >= (reminder.habitType === 'unlimited' ? 1 : reminder.dailyGoal);

async function alreadyLogged(habitId: number) {
  const reminders = await getEnabledReminders(localDateKey());
  const match = reminders.find((reminder) => reminder.habitId === habitId);
  return match ? isSatisfied(match) : false;
}

/**
 * Habits already complete today, held in memory so the foreground handler can consult it
 * without I/O. Keyed by date: a set left over from yesterday answers "not satisfied", which
 * errs on the side of showing the reminder.
 */
let satisfiedToday: { date: string; habitIds: Set<number> } = { date: '', habitIds: new Set() };
const isKnownSatisfied = (habitId: unknown) => satisfiedToday.date === localDateKey() && satisfiedToday.habitIds.has(Number(habitId));
function rememberSatisfaction(habitId: number, satisfied: boolean) {
  const today = localDateKey();
  if (satisfiedToday.date !== today) satisfiedToday = { date: today, habitIds: new Set() };
  if (satisfied) satisfiedToday.habitIds.add(habitId);
  else satisfiedToday.habitIds.delete(habitId);
}

// Expo discards a foreground notification when no handler is registered within
// three seconds. Register it as soon as this module loads.
if (!isExpoGo) {
  Notifications.setNotificationHandler({
    // Returns synchronously and does no I/O. Expo drops the notification if this handler
    // has not answered within three seconds, and a medication reminder must never be
    // traded for a database read. Redundant reminders are cleared by the received
    // listener instead, a moment later and with no deadline attached.
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      if (isReminderNotification(data) && isKnownSatisfied(data.habitId)) {
        addDiagnosticLog('info', 'presentation.suppressed', 'Habit already complete today; foreground reminder not shown.', { identifier: notification.request.identifier }).catch(console.error);
        return { shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false };
      }
      appendFileLog(`${new Date().toISOString()} [info] presentation.allowed ${notification.request.identifier}`);
      addDiagnosticLog('info', 'presentation.allowed', 'Foreground presentation handler allowed the notification.', { identifier: notification.request.identifier, title: notification.request.content.title }).catch(console.error);
      return { shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true };
    },
    handleSuccess: (notificationId) => addDiagnosticLog('info', 'presentation.success', 'Expo confirmed foreground presentation.', { notificationId }).catch(console.error),
    handleError: (notificationId, error) => { console.error('Notification presentation failed', error); addDiagnosticLog('error', 'presentation.failed', 'Expo could not present a foreground notification.', { notificationId, error: String(error) }).catch(console.error); },
  });
}

function buildHealth(partial: Omit<NotificationHealth, 'ready' | 'issue'>): NotificationHealth {
  const issue = ISSUE_SEVERITY.find((candidate) => partial.issues.includes(candidate));
  // Battery optimisation alone is a warning, not a failure: an exact allow-while-idle
  // alarm already pierces Doze. Everything else means a reminder can go missing.
  const blocking = partial.issues.filter((candidate) => candidate !== 'battery-optimized' && candidate !== 'alarms-repaired');
  return { ...partial, issue, ready: blocking.length === 0 && partial.scheduled === partial.expected };
}

async function ensureChannelAndCategory() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Important habit reminders',
      description: 'Time-sensitive scheduled reminders for habits and medication',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 150, 250],
      lightColor: ACCENT_COLOR,
      sound: 'default',
      audioAttributes: { usage: Notifications.AndroidAudioUsage.ALARM },
    });
  }
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    // Done opens the app on purpose. Expo queues a background action response in a
    // process-local in-memory list, so a press while the app is killed is dropped and the
    // dose is never recorded. Bringing the app up is the only way to guarantee the write.
    { identifier: 'TAKEN', buttonTitle: 'Done', options: { opensAppToForeground: true } },
    // Snooze stays in the background: losing one only costs a re-nudge, and the follow-up
    // nags already cover that case.
    { identifier: 'SNOOZE', buttonTitle: 'Snooze', options: { opensAppToForeground: false } },
  ]);
}

type PlannedNotification = {
  identifier: string;
  reminder: EnabledReminder;
  deliveryKind: Exclude<DeliveryKind, 'snooze' | 'catchup'>;
  hour: number;
  minute: number;
  fireAt?: Date;
};

/**
 * Primary reminders repeat forever. Follow-ups are dated one-offs so completing a habit
 * can cancel the rest of today's nags without also removing tomorrow's. A rolling window
 * keeps the alarm count bounded and is replenished whenever the app opens.
 *
 * A daily trigger cannot skip a single day, so a habit completed before its reminder time
 * trades the daily alarm for dated one-offs starting tomorrow. The next reconcile on a
 * later date, or undoing today's log, brings the daily alarm back.
 */
function planNotifications(reminders: EnabledReminder[]): PlannedNotification[] {
  const planned: PlannedNotification[] = [];
  for (const reminder of reminders) {
    if (isSatisfied(reminder) && occurrenceAt(reminder.hour, reminder.minute).getTime() > Date.now()) {
      for (let dayOffset = 1; dayOffset < ROLLING_HORIZON_DAYS; dayOffset += 1) {
        const fireAt = occurrenceAt(reminder.hour, reminder.minute, dayOffset);
        planned.push({ identifier: datedPrimaryId(reminder.id, fireAt), reminder, deliveryKind: 'primary', hour: reminder.hour, minute: reminder.minute, fireAt });
      }
    } else {
      planned.push({ identifier: primaryId(reminder.id), reminder, deliveryKind: 'primary', hour: reminder.hour, minute: reminder.minute });
    }
    const base = reminder.hour * 60 + reminder.minute;
    for (let index = 1; index <= reminder.followupCount; index += 1) {
      const at = base + index * reminder.followupMinutes;
      if (at >= 24 * 60) break;
      const hour = Math.floor(at / 60);
      const minute = at % 60;
      for (let dayOffset = 0; dayOffset < ROLLING_HORIZON_DAYS; dayOffset += 1) {
        const fireAt = occurrenceAt(hour, minute, dayOffset);
        if (fireAt.getTime() <= Date.now()) continue;
        if (dayOffset === 0 && isSatisfied(reminder)) continue;
        planned.push({ identifier: followupId(reminder.id, index, fireAt), reminder, deliveryKind: 'followup', hour, minute, fireAt });
      }
    }
  }
  return planned;
}

function contentFor(plan: PlannedNotification) {
  const { reminder } = plan;
  const due = occurrenceAt(reminder.hour, reminder.minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const progress = reminder.habitType === 'unlimited'
    ? reminder.todayCount > 0 ? ` · ${reminder.todayCount} logged today` : ''
    : reminder.dailyGoal > 1 ? ` · ${reminder.todayCount} of ${reminder.dailyGoal} today` : '';
  const title = reminder.label?.trim() || reminder.name;
  const body = plan.deliveryKind === 'followup'
    ? `Still not logged — due at ${due}.${progress}`
    : reminder.body?.trim() || `Due now${progress}.`;
  return {
    title: plan.deliveryKind === 'followup' ? `${title} — reminder` : title,
    body,
    categoryIdentifier: CATEGORY_ID,
    data: { kind: REMINDER_KIND, deliveryKind: plan.deliveryKind, reminderId: reminder.id, habitId: reminder.habitId, occurrenceDate: plan.fireAt ? localDateKey(plan.fireAt) : undefined },
    sound: 'default' as const,
    color: ACCENT_COLOR,
    priority: Notifications.AndroidNotificationPriority.MAX,
    // Stays in the tray until it is acted on or swiped away, so a reminder glanced at on
    // the lock screen and forgotten is still there later.
    autoDismiss: false,
  };
}

export async function configureNotifications(requestPermission = true): Promise<NotificationHealth> {
  const empty = { scheduled: 0, expected: 0, liveAlarms: null, repairedAlarms: 0, exactAlarms: null, batteryOptimized: null, device: null };
  if (isExpoGo) {
    await addDiagnosticLog('warning', 'configure.unsupported', 'Notification scheduling is unavailable in Expo Go.');
    return buildHealth({ ...empty, issues: ['scheduling-failed'] });
  }
  await addDiagnosticLog('info', 'configure.started', 'Checking notification configuration and synchronizing reminders.', { requestPermission });

  await ensureChannelAndCategory();

  const issues: NotificationIssue[] = [];
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === 'granted' || !requestPermission ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') {
    await addDiagnosticLog('error', 'permission.denied', 'Android notification permission is not granted.', permission);
    return buildHealth({ ...empty, issues: ['permission-denied'] });
  }

  if (Platform.OS === 'android') {
    const channel = await Notifications.getNotificationChannelAsync(CHANNEL_ID);
    if (!channel || channel.importance === Notifications.AndroidImportance.NONE) {
      await addDiagnosticLog('error', 'channel.disabled', 'The important reminder channel is missing or disabled.', channel);
      return buildHealth({ ...empty, issues: ['channel-disabled'] });
    }
  }

  // The check that was missing. Without the exact-alarm permission expo-notifications
  // falls back to AlarmManager.setAndAllowWhileIdle, and Android is then free to move
  // the reminder by minutes or defer it past a Doze window entirely.
  const device = getReliabilityStatus();
  const exactAlarms = device ? device.canScheduleExactAlarms : null;
  const batteryOptimized = device ? !device.isIgnoringBatteryOptimizations : null;
  if (exactAlarms === false) {
    issues.push('exact-alarms-blocked');
    await addDiagnosticLog('error', 'exact-alarms.blocked', 'Android will not let HabbitDot schedule exact alarms, so reminders can arrive late or not at all.', device);
  }
  if (batteryOptimized === true) issues.push('battery-optimized');
  if (!isReliabilityModuleAvailable) await addDiagnosticLog('warning', 'exact-alarms.unknown', 'The native reliability module is unavailable, so exact-alarm state could not be verified.');

  const reminders = await getEnabledReminders(localDateKey());
  const plans = planNotifications(reminders);
  const satisfiedHabitIds = new Set(reminders.filter(isSatisfied).map((reminder) => reminder.habitId));
  satisfiedToday = { date: localDateKey(), habitIds: satisfiedHabitIds };
  if (satisfiedHabitIds.size > 0) {
    for (const item of await withTimeout(Notifications.getPresentedNotificationsAsync(), [], 'getPresentedNotificationsAsync (clear satisfied)')) {
      const data = item.request.content.data;
      if (isReminderNotification(data) && satisfiedHabitIds.has(Number(data.habitId))) {
        await Notifications.dismissNotificationAsync(item.request.identifier);
      }
    }
    for (const habitId of satisfiedHabitIds) await forgetRemainingOccurrencesToday(habitId);
  }
  const scheduledBefore = await withTimeout(Notifications.getAllScheduledNotificationsAsync(), [], 'getAllScheduledNotificationsAsync');
  const desiredIds = new Set(plans.map((plan) => plan.identifier));
  const storedDesiredIds = scheduledBefore.filter((item) => desiredIds.has(item.identifier)).map((item) => item.identifier);
  const liveBefore = getScheduledAlarmLiveness(storedDesiredIds);
  const missingBefore = liveBefore === null ? [] : storedDesiredIds.filter((identifier) => !liveBefore[identifier]);
  if (missingBefore.length > 0) {
    issues.push('alarms-repaired');
    await addDiagnosticLog('warning', 'alarms.repairing', `Android had removed ${missingBefore.length} reminder alarm(s) while Expo still reported them as scheduled. Re-arming now.`, { identifiers: missingBefore });
  }
  let schedulingFailed = false;

  // Primaries use native daily triggers unless today is already done. Follow-ups use dated
  // triggers because a daily alarm cannot be canceled for today alone.
  for (const plan of plans) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: plan.identifier,
        content: contentFor(plan),
        trigger: plan.fireAt
          ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date: plan.fireAt, channelId: CHANNEL_ID }
          : { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: plan.hour, minute: plan.minute, channelId: CHANNEL_ID },
      });
      if (plan.deliveryKind === 'primary') await setReminderNotificationId(plan.reminder.id, plan.identifier);
      // Journal the next two primary occurrences, or this exact follow-up occurrence.
      for (const at of plan.fireAt ? [plan.fireAt] : [occurrenceAt(plan.hour, plan.minute), occurrenceAt(plan.hour, plan.minute, 1)]) {
        if (at.getTime() <= Date.now()) continue;
        await recordExpectedDelivery({ reminderId: plan.reminder.id, habitId: plan.reminder.habitId, occurrenceAt: at.toISOString(), kind: plan.deliveryKind, identifier: plan.identifier });
      }
      await addDiagnosticLog('info', 'schedule.accepted', `Scheduled ${plan.reminder.name} (${plan.deliveryKind}) for ${plan.fireAt ? plan.fireAt.toLocaleString() : `${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')} daily`}.`, { reminderId: plan.reminder.id, habitId: plan.reminder.habitId, identifier: plan.identifier });
    } catch (error) {
      schedulingFailed = true;
      console.error(`Could not schedule ${plan.identifier}`, error);
      await addDiagnosticLog('error', 'schedule.failed', `Could not schedule ${plan.identifier}.`, String(error));
    }
  }

  // Remove only obsolete/legacy habit reminders. Snoozes and unrelated checks survive,
  // except a snooze for a habit that has since been completed.
  if (!schedulingFailed) {
    for (const item of scheduledBefore) {
      const data = item.content.data;
      const isManaged = data?.kind === REMINDER_KIND || item.content.categoryIdentifier === CATEGORY_ID;
      const isSnooze = data?.kind === 'habbitdot-snooze';
      if (isManaged && (isSnooze ? satisfiedHabitIds.has(Number(data?.habitId)) : !desiredIds.has(item.identifier))) {
        await Notifications.cancelScheduledNotificationAsync(item.identifier);
      }
    }
  }

  const scheduledAfter = await withTimeout(Notifications.getAllScheduledNotificationsAsync(), [], 'getAllScheduledNotificationsAsync (verify)');
  const accepted = scheduledAfter.filter((item) => desiredIds.has(item.identifier)).length;
  const liveAfter = getScheduledAlarmLiveness([...desiredIds]);
  const liveAlarms = liveAfter === null ? null : [...desiredIds].filter((identifier) => liveAfter[identifier]).length;
  if (liveAlarms !== null && liveAlarms !== plans.length) {
    issues.push('alarms-missing');
    await addDiagnosticLog('error', 'alarms.missing', `Android owns only ${liveAlarms} of ${plans.length} expected reminder alarm(s), even after re-arming.`, { liveness: liveAfter });
  } else if (missingBefore.length > 0) {
    await addDiagnosticLog('warning', 'alarms.repaired', `Restored ${missingBefore.length} reminder alarm(s) removed by Android.`, { identifiers: missingBefore });
  }
  if (schedulingFailed || accepted !== plans.length) issues.push('scheduling-failed');

  await reconcileDeliveryJournal();

  const health = buildHealth({ scheduled: accepted, expected: plans.length, liveAlarms, repairedAlarms: missingBefore.length, issues, exactAlarms, batteryOptimized, device });
  await addDiagnosticLog(health.ready ? 'info' : 'error', 'configure.finished', `Expo stores ${accepted} of ${plans.length} notification(s); Android owns ${liveAlarms === null ? 'an unknown number of' : `${liveAlarms} of ${plans.length}`} alarm(s); exact alarms ${exactAlarms === null ? 'unknown' : exactAlarms ? 'allowed' : 'BLOCKED'}.`, {
    issues,
    exactAlarms,
    batteryOptimized,
    scheduledIdentifiers: scheduledAfter.filter((item) => desiredIds.has(item.identifier)).map((item) => item.identifier),
  });
  return health;
}

/**
 * Every expo-notifications call is dispatched to a native queue; one that never settles
 * blocks every later call, including the next attempt to schedule a reminder. Nothing in
 * the reconcile is important enough to risk that, so each call gets a deadline.
 */
function withTimeout<T>(operation: Promise<T>, fallback: T, label: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      addDiagnosticLog('error', 'native.timeout', `${label} did not respond within ${ms} ms; continuing without it.`).catch(console.error);
      resolve(fallback);
    }, ms);
    operation
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        addDiagnosticLog('warning', 'native.failed', `${label} failed.`, String(error)).catch(console.error);
        resolve(fallback);
      });
  });
}

/** Closes out occurrences whose moment has passed, crediting anything still in the tray. */
async function reconcileDeliveryJournal() {
  const presentedItems = await withTimeout(Notifications.getPresentedNotificationsAsync(), [], 'getPresentedNotificationsAsync');
  const presented = presentedItems.map((item) => item.request.identifier);
  const unconfirmed = await withTimeout(sweepUnconfirmedDeliveries(new Date().toISOString(), presented), [], 'sweepUnconfirmedDeliveries');
  for (const item of unconfirmed) {
    await addDiagnosticLog('warning', 'delivery.unconfirmed', `The ${item.kind} reminder for ${item.habitName} at ${new Date(item.occurrenceAt).toLocaleString()} was never confirmed by the app.`, item);
  }
}

/**
 * Reminders whose time has passed today that are still not logged. This is the safety net
 * the user actually feels, and it depends on no inference about delivery: the moment
 * passed, the dose is not recorded, so say so.
 */
export async function getMissedToday() {
  const now = new Date();
  return getOverdueReminders(localDateKey(now), now.getHours() * 60 + now.getMinutes());
}

/**
 * Posts one catch-up notification per reminder per day once a dose is well overdue, so a
 * dropped reminder still surfaces without the user having to open the app.
 */
export async function notifyMissedReminders(minimumOverdueMinutes = 45) {
  if (isExpoGo) return 0;
  const now = new Date();
  const today = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let posted = 0;
  for (const reminder of await getMissedToday()) {
    const overdueBy = nowMinutes - (reminder.hour * 60 + reminder.minute);
    if (overdueBy < minimumOverdueMinutes) continue;
    const occurrence = occurrenceAt(reminder.hour, reminder.minute);
    const identifier = `habit-catchup-${reminder.id}-${today}`;
    try {
      // The unique index on (reminder, occurrence, kind) makes this idempotent: a second
      // pass on the same day updates the row instead of posting another notification.
      const { changes } = await getCatchupClaim(reminder.id, reminder.habitId, occurrence.toISOString(), identifier);
      if (!changes) continue;
      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title: `Missed: ${reminder.name}`,
          body: `Due at ${occurrence.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} and still not logged.`,
          categoryIdentifier: CATEGORY_ID,
          data: { kind: 'habbitdot-catchup', deliveryKind: 'catchup', reminderId: reminder.id, habitId: reminder.habitId },
          sound: 'default',
          color: ACCENT_COLOR,
          priority: Notifications.AndroidNotificationPriority.MAX,
          autoDismiss: false,
        },
        // Not `trigger: null`. Expo carries the channel on the trigger, so an immediate
        // notification lands on its fallback channel at default importance instead of the
        // max-importance alarm channel this is the whole point of.
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 1,
          channelId: CHANNEL_ID,
        },
      });
      posted += 1;
      await addDiagnosticLog('warning', 'catchup.posted', `Posted a catch-up notification for ${reminder.name}, overdue by ${overdueBy} minutes.`, { reminderId: reminder.id });
    } catch (error) {
      await addDiagnosticLog('error', 'catchup.failed', `Could not post a catch-up notification for ${reminder.name}.`, String(error));
    }
  }
  return posted;
}

export async function scheduleDeliveryVerification(seconds = 10) {
  if (isExpoGo) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'HabbitDot reminders are ready',
      body: 'This one-time check confirms background notifications are working.',
      sound: 'default',
      color: ACCENT_COLOR,
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
      channelId: CHANNEL_ID,
    },
  });
}

export async function getNotificationDiagnostics() {
  if (isExpoGo) { await addDiagnosticLog('warning', 'diagnostics.unsupported', 'Diagnostics are unavailable in Expo Go.'); return; }
  const [permission, scheduled, presented] = await Promise.all([
    Notifications.getPermissionsAsync(),
    Notifications.getAllScheduledNotificationsAsync(),
    Notifications.getPresentedNotificationsAsync().catch(() => []),
  ]);
  const channel = Platform.OS === 'android' ? await Notifications.getNotificationChannelAsync(CHANNEL_ID) : null;
  const device = getReliabilityStatus();
  const withNextFire = scheduled.map((item) => {
    const trigger = item.trigger as { type?: string; hour?: number; minute?: number };
    const nextFire = trigger?.type === 'daily' && typeof trigger.hour === 'number' && typeof trigger.minute === 'number'
      ? nextDailyOccurrence(trigger.hour, trigger.minute).toISOString()
      : null;
    return { identifier: item.identifier, title: item.content.title, nextFire, trigger: item.trigger };
  });
  const managedIds = scheduled.filter((item) => isReminderNotification(item.content.data)).map((item) => item.identifier);
  const liveness = getScheduledAlarmLiveness(managedIds);
  const liveCount = liveness === null ? null : managedIds.filter((identifier) => liveness[identifier]).length;
  await addDiagnosticLog(liveCount !== null && liveCount !== managedIds.length ? 'error' : 'info', 'diagnostics.snapshot', `Permission: ${permission.status}; exact alarms ${device === null ? 'unknown' : device.canScheduleExactAlarms ? 'allowed' : 'BLOCKED'}; Expo stores ${managedIds.length} reminder(s), Android owns ${liveCount === null ? 'an unknown number of' : liveCount} alarm(s), ${presented.length} in the tray.`, {
    device,
    channel: channel ? { id: channel.id, importance: channel.importance, sound: channel.sound, vibrationPattern: channel.vibrationPattern } : null,
    presented: presented.map((item) => item.request.identifier),
    scheduled: withNextFire,
    alarmLiveness: liveness,
  });
  await reconcileDeliveryJournal();
}

export async function listenForNotificationActions(onChanged: () => void, onOpen: (habitId: number) => void) {
  if (isExpoGo) return null;
  const received = Notifications.addNotificationReceivedListener((notification) => {
    const identifier = notification.request.identifier;
    const data = notification.request.content.data;
    markDeliveryDelivered(identifier, new Date().toISOString()).catch(console.error);
    addDiagnosticLog('info', 'notification.received', 'JavaScript received the notification event.', { identifier, title: notification.request.content.title, data }).catch(console.error);
    // The handler above suppresses a redundant reminder while the app is foregrounded;
    // this clears one that Android had already posted from the background.
    if (isReminderNotification(data) && data.deliveryKind !== 'catchup' && typeof data.habitId === 'number') {
      alreadyLogged(data.habitId)
        .then((satisfied) => satisfied ? Notifications.dismissNotificationAsync(identifier) : undefined)
        .catch(console.error);
    }
  });
  const responseSubscription = Notifications.addNotificationResponseReceivedListener(async (response) => {
    const identifier = response.notification.request.identifier;
    const data = response.notification.request.content.data;
    const now = new Date();
    await markDeliveryActed(identifier, response.actionIdentifier, now.toISOString());
    await addDiagnosticLog('info', 'notification.action', `Notification action: ${response.actionIdentifier}.`, { identifier, data });
    const habitId = Number(data?.habitId);
    if (!habitId) return;
    if (response.actionIdentifier === 'TAKEN') {
      await incrementEntry(habitId, localDateKey(now));
      // Android does not clear the tray copy when an action button is pressed.
      await Notifications.dismissNotificationAsync(identifier).catch(console.error);
      await settleRemindersFor(habitId);
      onChanged();
    } else if (response.actionIdentifier === 'SNOOZE') {
      const reminders = await getEnabledReminders(localDateKey(now));
      const minutes = reminders.find((item) => item.id === Number(data?.reminderId))?.snoozeMinutes ?? 10;
      await Notifications.dismissNotificationAsync(identifier).catch(console.error);
      const snoozeIdentifier = `habit-snooze-${habitId}-${now.getTime()}`;
      await Notifications.scheduleNotificationAsync({
        identifier: snoozeIdentifier,
        content: {
          title: response.notification.request.content.title ?? 'Habit reminder',
          body: `Snoozed reminder — ${minutes} minute${minutes === 1 ? '' : 's'} are up.`,
          categoryIdentifier: CATEGORY_ID,
          data: { kind: 'habbitdot-snooze', deliveryKind: 'snooze', habitId, reminderId: Number(data?.reminderId) || undefined },
          sound: 'default',
          color: ACCENT_COLOR,
          priority: Notifications.AndroidNotificationPriority.MAX,
          autoDismiss: false,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: minutes * 60,
          channelId: CHANNEL_ID,
        },
      });
      await addDiagnosticLog('info', 'snooze.scheduled', `Snoozed ${response.notification.request.content.title ?? 'reminder'} for ${minutes} minutes.`, { snoozeIdentifier });
    } else if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
      onOpen(habitId);
    }
  });
  return { remove: () => { received.remove(); responseSubscription.remove(); } };
}

/**
 * Brings today's reminders in line with a change to today's count, made in the app or from
 * a notification. Once the habit is complete this clears tray copies, today's remaining
 * follow-ups and any pending snooze. The primary alarm is swapped by the reconcile the
 * caller schedules next, which also restores everything if the log is undone.
 */
export async function settleRemindersFor(habitId: number) {
  if (isExpoGo) return;
  try {
    const satisfied = await alreadyLogged(habitId);
    rememberSatisfaction(habitId, satisfied);
    if (!satisfied) return;
    for (const item of await Notifications.getPresentedNotificationsAsync()) {
      const data = item.request.content.data;
      if (isReminderNotification(data) && Number(data.habitId) === habitId) {
        await Notifications.dismissNotificationAsync(item.request.identifier);
      }
    }
    const today = localDateKey();
    const cancelled: string[] = [];
    for (const item of await Notifications.getAllScheduledNotificationsAsync()) {
      const data = item.content.data;
      if (!isReminderNotification(data) || Number(data.habitId) !== habitId) continue;
      const todaysFollowup = data.deliveryKind === 'followup' && data.occurrenceDate === today;
      if (todaysFollowup || data.deliveryKind === 'snooze') {
        await Notifications.cancelScheduledNotificationAsync(item.identifier);
        cancelled.push(item.identifier);
      }
    }
    await forgetRemainingOccurrencesToday(habitId);
    await addDiagnosticLog('info', 'reminders.settled', `Habit complete for today; cancelled ${cancelled.length} pending reminder(s).`, { habitId, cancelled });
  } catch (error) {
    console.error('Could not clear reminders after logging', error);
  }
}

/** Occurrences cancelled because the habit is done must not later read as "never confirmed". */
async function forgetRemainingOccurrencesToday(habitId: number) {
  await dropScheduledDeliveries(habitId, new Date().toISOString(), occurrenceAt(0, 0, 1).toISOString());
}

/**
 * The habit whose notification body was tapped to launch the app. Action buttons launch it
 * too (Done opens the app on purpose) but must not navigate anywhere. The response is
 * cleared once read so a later launch cannot replay it.
 */
export function getLastOpenedHabitId() {
  if (isExpoGo) return null;
  const response = Notifications.getLastNotificationResponse();
  if (!response) return null;
  Notifications.clearLastNotificationResponse();
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const habitId = Number(response.notification.request.content.data?.habitId);
  return habitId || null;
}
