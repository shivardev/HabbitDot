import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  openBatteryOptimizationSettings,
  openChannelSettings,
  openExactAlarmSettings,
  openNotificationSettings,
} from '../modules/habbitdot-reliability';
import { NotificationHealth, NotificationIssue, REMINDER_CHANNEL_ID } from './notifications';

type MissedReminder = { id: number; habitId: number; name: string; hour: number; minute: number; dailyGoal: number; todayCount: number };

const timeLabel = (hour: number, minute: number) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Each issue states the consequence rather than the mechanism, and offers the one screen
 * that resolves it. "Alarms & reminders is off" means nothing; "reminders can arrive late
 * or not at all" is the reason to walk into Settings.
 */
const ISSUE_COPY: Record<NotificationIssue, { severity: 'error' | 'warning'; title: string; body: string; short?: string; action: string; fix: () => void }> = {
  'permission-denied': {
    severity: 'error',
    title: 'REMINDERS ARE BLOCKED',
    body: 'HabbitDot is not allowed to post notifications, so no reminder can reach you.',
    action: 'ALLOW NOTIFICATIONS',
    fix: openNotificationSettings,
  },
  'channel-disabled': {
    severity: 'error',
    title: 'REMINDER CHANNEL IS OFF',
    body: 'The important reminders channel is turned off. Reminders are scheduled but never shown.',
    action: 'TURN CHANNEL ON',
    fix: () => openChannelSettings(REMINDER_CHANNEL_ID),
  },
  'exact-alarms-blocked': {
    severity: 'error',
    title: 'REMINDERS CAN ARRIVE LATE',
    body: 'Android will not let HabbitDot set exact alarms, so it is free to delay or drop a reminder. Turn on "Alarms & reminders" to fix this.',
    action: 'ALLOW EXACT ALARMS',
    fix: openExactAlarmSettings,
  },
  'alarms-missing': {
    severity: 'error',
    title: 'REMINDER ALARMS ARE MISSING',
    body: 'Expo remembers the reminders, but Android removed their alarms. Review battery settings, then return so HabbitDot can re-arm them.',
    action: 'REVIEW BATTERY',
    fix: openBatteryOptimizationSettings,
  },
  'alarms-repaired': {
    severity: 'warning',
    title: 'REMINDER ALARMS WERE RESTORED',
    short: 'Android removed some alarms; they are re-armed',
    body: 'Android removed one or more reminder alarms while HabbitDot was closed. They are armed again; unrestricted battery use can prevent this happening overnight.',
    action: 'REVIEW BATTERY',
    fix: openBatteryOptimizationSettings,
  },
  'scheduling-failed': {
    severity: 'error',
    title: 'SOME REMINDERS DID NOT SCHEDULE',
    body: 'Android did not accept every reminder. Open the logs to see which one failed.',
    action: 'OPEN SETTINGS',
    fix: openNotificationSettings,
  },
  'battery-optimized': {
    severity: 'warning',
    title: 'BATTERY OPTIMISATION IS ON',
    short: 'Battery optimisation is on',
    body: 'Reminders still work, but some phones kill background apps aggressively. Allowing unrestricted battery use makes delivery more dependable.',
    action: 'REVIEW BATTERY',
    fix: openBatteryOptimizationSettings,
  },
};

/**
 * Errors mean a reminder can go missing, so they get the full card and cannot be hidden.
 * Warnings are advisory and would otherwise sit on the home screen every day, so they
 * collapse to one dismissible line; the Logs screen still lists them.
 */
export function ReminderHealthBanner({ health, dismissed, onDismiss, onOpenLogs }: { health: NotificationHealth | null; dismissed: NotificationIssue[]; onDismiss: (issue: NotificationIssue) => void; onOpenLogs: () => void }) {
  const issues = health?.issues.filter((issue) => ISSUE_COPY[issue].severity === 'error' || !dismissed.includes(issue)) ?? [];
  if (issues.length === 0) return null;
  return <View style={styles.stack}>
    {issues.map((issue) => {
      const copy = ISSUE_COPY[issue];
      if (copy.severity === 'warning') {
        return <View key={issue} style={styles.strip}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${copy.short ?? copy.title}. Open details`} onPress={onOpenLogs} style={styles.stripLabel}>
            <View style={styles.stripDot} />
            <Text numberOfLines={1} style={styles.stripText}>{copy.short ?? copy.title}</Text>
          </Pressable>
          <Pressable accessibilityLabel={copy.action} hitSlop={6} onPress={copy.fix} style={styles.stripFix}><Text style={styles.stripFixText}>FIX</Text></Pressable>
          <Pressable accessibilityLabel={`Hide ${copy.short ?? copy.title}`} hitSlop={8} onPress={() => onDismiss(issue)} style={styles.stripClose}><Text style={styles.stripCloseText}>×</Text></Pressable>
        </View>;
      }
      return <View key={issue} style={[styles.card, copy.severity === 'error' ? styles.errorCard : styles.warningCard]}>
        <Text style={[styles.title, copy.severity === 'error' ? styles.errorText : styles.warningText]}>{copy.title}</Text>
        <Text style={styles.body}>{copy.body}</Text>
        <View style={styles.actions}>
          <Pressable onPress={copy.fix} style={[styles.primary, copy.severity === 'error' ? styles.errorButton : styles.warningButton]}><Text style={styles.primaryText}>{copy.action}</Text></Pressable>
          <Pressable onPress={onOpenLogs} style={styles.secondary}><Text style={styles.secondaryText}>DETAILS</Text></Pressable>
        </View>
      </View>;
    })}
  </View>;
}

/**
 * The last line of defence, and the only one that needs no cooperation from Android: the
 * time passed, the dose is not recorded, so it is shown until it is dealt with.
 */
export function MissedTodayBanner({ missed, onLog }: { missed: MissedReminder[]; onLog: (habitId: number) => void }) {
  if (missed.length === 0) return null;
  return <View style={[styles.card, styles.missedCard]}>
    <Text style={[styles.title, styles.missedText]}>DUE AND NOT LOGGED</Text>
    {missed.map((reminder) => <View key={reminder.id} style={styles.missedRow}>
      <View style={styles.missedIdentity}>
        <Text style={styles.missedName}>{reminder.name}</Text>
        <Text style={styles.missedMeta}>{timeLabel(reminder.hour, reminder.minute)}{reminder.dailyGoal > 1 ? ` · ${reminder.todayCount} of ${reminder.dailyGoal}` : ''}</Text>
      </View>
      <Pressable onPress={() => onLog(reminder.habitId)} style={styles.logButton}><Text style={styles.logButtonText}>LOG IT</Text></Pressable>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginBottom: 6 },
  strip: { alignItems: 'center', borderColor: '#2A2A2E', borderRadius: 8, borderWidth: 1, flexDirection: 'row', paddingLeft: 10 },
  stripLabel: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7, paddingVertical: 7 },
  stripDot: { backgroundColor: '#FFB86B', borderRadius: 3, height: 6, width: 6 },
  stripText: { color: '#A3A3AA', flex: 1, fontSize: 9, fontWeight: '700' },
  stripFix: { paddingHorizontal: 8, paddingVertical: 7 },
  stripFixText: { color: '#FFB86B', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  stripClose: { paddingHorizontal: 10, paddingVertical: 4 },
  stripCloseText: { color: '#6E6E75', fontSize: 15, fontWeight: '700' },
  card: { backgroundColor: '#111113', borderColor: '#303034', borderLeftWidth: 3, borderRadius: 11, borderWidth: 1, marginBottom: 10, padding: 13 },
  errorCard: { borderLeftColor: '#FF7780' },
  warningCard: { borderLeftColor: '#FFB86B' },
  missedCard: { borderLeftColor: '#B7F171' },
  title: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  errorText: { color: '#FF7780' },
  warningText: { color: '#FFB86B' },
  missedText: { color: '#B7F171' },
  body: { color: '#ACACB2', fontSize: 10, lineHeight: 16, marginTop: 7 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  primary: { alignItems: 'center', borderRadius: 9, flex: 1, paddingVertical: 12 },
  errorButton: { backgroundColor: '#FF7780' },
  warningButton: { backgroundColor: '#FFB86B' },
  primaryText: { color: '#101012', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  secondary: { alignItems: 'center', borderColor: '#45454C', borderRadius: 9, borderWidth: 1, justifyContent: 'center', paddingHorizontal: 16 },
  secondaryText: { color: '#DADAD8', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  missedRow: { alignItems: 'center', borderTopColor: '#252529', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, paddingTop: 10 },
  missedIdentity: { flex: 1 },
  missedName: { color: '#F4F4F2', fontSize: 12, fontWeight: '900' },
  missedMeta: { color: '#7E7E85', fontSize: 8, marginTop: 3 },
  logButton: { alignItems: 'center', backgroundColor: '#B7F171', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  logButtonText: { color: '#101012', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
});
