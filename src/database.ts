import * as SQLite from 'expo-sqlite';
import { appendFileLog } from '../modules/habbitdot-reliability';

export type ReminderTime = { id: number; hour: number; minute: number; enabled: boolean; label: string | null; body: string | null; snoozeMinutes: number; followupMinutes: number; followupCount: number };
export type DiagnosticLog = { id: number; createdAt: string; level: 'info' | 'warning' | 'error'; step: string; message: string; details: string | null };
export type DeliveryKind = 'primary' | 'followup' | 'snooze' | 'catchup';
export type DeliveryState = 'scheduled' | 'delivered' | 'acted' | 'unconfirmed';
export type ReminderDelivery = { id: number; reminderId: number; habitId: number; habitName: string; occurrenceAt: string; kind: DeliveryKind; identifier: string; state: DeliveryState; deliveredAt: string | null; actedAt: string | null; action: string | null };
export const REMINDER_DEFAULTS = { snoozeMinutes: 10, followupMinutes: 15, followupCount: 2 };
export type HabitType = 'target' | 'unlimited';
export type Habit = { id: number; name: string; color: string; createdAt: string; dailyGoal: number; habitType: HabitType; reminderHour: number | null; reminderMinute: number | null; reminderEnabled: boolean; reminders: ReminderTime[]; completedDates: string[]; completionCounts: Record<string, number>; currentStreak: number };
export type HabbitDotBackup = {
  format: 'habbitdot-backup';
  version: 1;
  exportedAt: string;
  habits: Array<{ id: number; name: string; color: string; createdAt: string; archivedAt: string | null; dailyGoal: number; habitType?: HabitType }>;
  entries: Array<{ habitId: number; entryDate: string; completedAt: string; completionCount: number }>;
  // The delivery fields are optional so backups written before they existed still restore.
  reminders: Array<{ id: number; habitId: number; hour: number; minute: number; enabled: boolean; label?: string | null; body?: string | null; snoozeMinutes?: number; followupMinutes?: number; followupCount?: number }>;
  settings: Array<{ key: string; value: string }>;
};
let database: SQLite.SQLiteDatabase | null = null;
async function getDatabase() { if (!database) database = await SQLite.openDatabaseAsync('habbitdot.db'); return database; }

export async function initializeDatabase() {
  const db = await getDatabase();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS habits (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE IF NOT EXISTS habit_entries (habit_id INTEGER NOT NULL, entry_date TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY (habit_id, entry_date), FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS habit_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER NOT NULL, hour INTEGER NOT NULL, minute INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, notification_id TEXT, FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS diagnostic_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, level TEXT NOT NULL, step TEXT NOT NULL, message TEXT NOT NULL, details TEXT);
    CREATE INDEX IF NOT EXISTS diagnostic_logs_created_at ON diagnostic_logs(created_at DESC);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
  `);
  try { await db.execAsync('ALTER TABLE habits ADD COLUMN daily_goal INTEGER NOT NULL DEFAULT 1'); } catch {}
  try { await db.execAsync("ALTER TABLE habits ADD COLUMN habit_type TEXT NOT NULL DEFAULT 'target'"); } catch {}
  const unlimitedMigration = await db.runAsync("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))");
  if (unlimitedMigration.changes > 0) await db.runAsync("UPDATE habits SET habit_type = 'unlimited' WHERE lower(trim(name)) = 'minoxidil'");
  try { await db.execAsync('ALTER TABLE habit_entries ADD COLUMN completion_count INTEGER NOT NULL DEFAULT 1'); } catch {}
  // Per-reminder delivery behaviour. Added in place so existing habits and history survive the upgrade.
  try { await db.execAsync('ALTER TABLE habit_reminders ADD COLUMN label TEXT'); } catch {}
  try { await db.execAsync('ALTER TABLE habit_reminders ADD COLUMN body TEXT'); } catch {}
  try { await db.execAsync(`ALTER TABLE habit_reminders ADD COLUMN snooze_minutes INTEGER NOT NULL DEFAULT ${REMINDER_DEFAULTS.snoozeMinutes}`); } catch {}
  try { await db.execAsync(`ALTER TABLE habit_reminders ADD COLUMN followup_minutes INTEGER NOT NULL DEFAULT ${REMINDER_DEFAULTS.followupMinutes}`); } catch {}
  try { await db.execAsync(`ALTER TABLE habit_reminders ADD COLUMN followup_count INTEGER NOT NULL DEFAULT ${REMINDER_DEFAULTS.followupCount}`); } catch {}
  // Every occurrence the app expects Android to deliver, and what actually happened to it.
  // Without this a missed dose leaves no trace: Android forgets a fired alarm within minutes.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS reminder_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER NOT NULL,
      habit_id INTEGER NOT NULL,
      occurrence_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      identifier TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'scheduled',
      delivered_at TEXT,
      acted_at TEXT,
      action TEXT,
      UNIQUE (reminder_id, occurrence_at, kind)
    );
    CREATE INDEX IF NOT EXISTS reminder_deliveries_occurrence ON reminder_deliveries(occurrence_at DESC);
    CREATE INDEX IF NOT EXISTS reminder_deliveries_identifier ON reminder_deliveries(identifier);
  `);
}

type HabitRow = { id: number; name: string; color: string; createdAt: string; dailyGoal: number; habitType: HabitType; reminderHour: number | null; reminderMinute: number | null; reminderEnabled: number };
type EntryRow = { habitId: number; entryDate: string; completionCount: number };
type ReminderRow = { id: number; habitId: number; hour: number; minute: number; enabled: number; label: string | null; body: string | null; snoozeMinutes: number; followupMinutes: number; followupCount: number };
function streakFor(dates: string[]) {
  const completed = new Set(dates); const cursor = new Date(); let streak = 0;
  while (completed.has(cursor.toISOString().slice(0, 10))) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

export async function getHabits(): Promise<Habit[]> {
  const db = await getDatabase();
  const habits = await db.getAllAsync<HabitRow>(`SELECT h.id, h.name, h.color, h.created_at AS createdAt, h.daily_goal AS dailyGoal, h.habit_type AS habitType,
    (SELECT hour FROM habit_reminders WHERE habit_id = h.id ORDER BY id LIMIT 1) AS reminderHour,
    (SELECT minute FROM habit_reminders WHERE habit_id = h.id ORDER BY id LIMIT 1) AS reminderMinute,
    COALESCE((SELECT enabled FROM habit_reminders WHERE habit_id = h.id ORDER BY id LIMIT 1), 0) AS reminderEnabled
    FROM habits h WHERE h.archived_at IS NULL ORDER BY h.id DESC`);
  const entries = await db.getAllAsync<EntryRow>('SELECT habit_id AS habitId, entry_date AS entryDate, completion_count AS completionCount FROM habit_entries ORDER BY entry_date');
  const reminders = await db.getAllAsync<ReminderRow>(`SELECT id, habit_id AS habitId, hour, minute, enabled, label, body,
    snooze_minutes AS snoozeMinutes, followup_minutes AS followupMinutes, followup_count AS followupCount
    FROM habit_reminders ORDER BY hour, minute, id`);
  return habits.map((habit) => { const ownEntries = entries.filter((entry) => entry.habitId === habit.id); const ownReminders = reminders.filter((reminder) => reminder.habitId === habit.id).map(({ id, hour, minute, enabled, label, body, snoozeMinutes, followupMinutes, followupCount }) => ({ id, hour, minute, enabled: Boolean(enabled), label, body, snoozeMinutes, followupMinutes, followupCount })); const completionCounts = Object.fromEntries(ownEntries.map((entry) => [entry.entryDate, entry.completionCount])); const completedDates = ownEntries.filter((entry) => habit.habitType === 'unlimited' ? entry.completionCount > 0 : entry.completionCount >= habit.dailyGoal).map((entry) => entry.entryDate); return { ...habit, reminderEnabled: Boolean(habit.reminderEnabled), reminders: ownReminders, completionCounts, completedDates, currentStreak: streakFor(completedDates) }; });
}

export async function addHabit(name: string, color: string) {
  const db = await getDatabase();
  await db.runAsync('INSERT INTO habits(name, color, created_at) VALUES (?, ?, ?)', name, color, new Date().toISOString());
}

export async function toggleEntry(habitId: number, entryDate: string) {
  const db = await getDatabase();
  const existing = await db.getFirstAsync<{ completionCount: number }>('SELECT completion_count AS completionCount FROM habit_entries WHERE habit_id = ? AND entry_date = ?', habitId, entryDate);
  const habit = await db.getFirstAsync<{ dailyGoal: number; habitType: HabitType }>('SELECT daily_goal AS dailyGoal, habit_type AS habitType FROM habits WHERE id = ?', habitId);
  if (habit?.habitType === 'unlimited' && existing) await db.runAsync('UPDATE habit_entries SET completion_count = completion_count + 1, completed_at = ? WHERE habit_id = ? AND entry_date = ?', new Date().toISOString(), habitId, entryDate);
  else if (existing && existing.completionCount >= (habit?.dailyGoal ?? 1)) await db.runAsync('DELETE FROM habit_entries WHERE habit_id = ? AND entry_date = ?', habitId, entryDate);
  else if (existing) await db.runAsync('UPDATE habit_entries SET completion_count = completion_count + 1, completed_at = ? WHERE habit_id = ? AND entry_date = ?', new Date().toISOString(), habitId, entryDate);
  else await db.runAsync('INSERT INTO habit_entries(habit_id, entry_date, completed_at, completion_count) VALUES (?, ?, ?, 1)', habitId, entryDate, new Date().toISOString());
}

export async function incrementEntry(habitId: number, entryDate: string) {
  const db = await getDatabase();
  await db.runAsync(`INSERT INTO habit_entries(habit_id, entry_date, completed_at, completion_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(habit_id, entry_date) DO UPDATE SET completion_count = CASE WHEN (SELECT habit_type FROM habits WHERE id = ?) = 'unlimited' THEN completion_count + 1 ELSE MIN(completion_count + 1, (SELECT daily_goal FROM habits WHERE id = ?)) END, completed_at = excluded.completed_at`, habitId, entryDate, new Date().toISOString(), habitId, habitId);
}

export async function decrementEntry(habitId: number, entryDate: string) {
  const db = await getDatabase();
  const existing = await db.getFirstAsync<{ completionCount: number }>('SELECT completion_count AS completionCount FROM habit_entries WHERE habit_id = ? AND entry_date = ?', habitId, entryDate);
  if (!existing) return;
  if (existing.completionCount <= 1) await db.runAsync('DELETE FROM habit_entries WHERE habit_id = ? AND entry_date = ?', habitId, entryDate);
  else await db.runAsync('UPDATE habit_entries SET completion_count = completion_count - 1, completed_at = ? WHERE habit_id = ? AND entry_date = ?', new Date().toISOString(), habitId, entryDate);
}

export async function getSetting(key: string) { const db = await getDatabase(); return (await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key))?.value ?? null; }
export async function setSetting(key: string, value: string) { const db = await getDatabase(); await db.runAsync('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }
export async function updateDailyGoal(habitId: number, dailyGoal: number) { const db = await getDatabase(); await db.runAsync('UPDATE habits SET daily_goal = ? WHERE id = ?', Math.max(1, Math.min(20, dailyGoal)), habitId); }
export async function updateHabit(habitId: number, name: string, color: string, dailyGoal: number, habitType: HabitType) { const db = await getDatabase(); await db.runAsync('UPDATE habits SET name = ?, color = ?, daily_goal = ?, habit_type = ? WHERE id = ?', name.trim(), color, Math.max(1, Math.min(20, dailyGoal)), habitType, habitId); }
export type EditableReminderInput = { hour: number; minute: number; enabled: boolean; label?: string | null; body?: string | null; snoozeMinutes?: number; followupMinutes?: number; followupCount?: number };
const clampInt = (value: number | undefined, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value as number))) : fallback;
const trimOrNull = (value: string | null | undefined) => { const text = (value ?? '').trim(); return text ? text.slice(0, 120) : null; };

export async function replaceHabitReminders(habitId: number, reminders: EditableReminderInput[]) {
  const db = await getDatabase();
  // Exclusive: a reconcile pass triggered elsewhere reads and writes these same tables,
  // and expo-sqlite's plain withTransactionAsync is documented as unsafe under concurrent
  // use — interleaving there wedges the save instead of failing it.
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('DELETE FROM habit_reminders WHERE habit_id = ?', habitId);
    for (const reminder of reminders) {
      await transaction.runAsync('INSERT INTO habit_reminders(habit_id, hour, minute, enabled, label, body, snooze_minutes, followup_minutes, followup_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        habitId, reminder.hour, reminder.minute, reminder.enabled ? 1 : 0, trimOrNull(reminder.label), trimOrNull(reminder.body),
        clampInt(reminder.snoozeMinutes, 1, 240, REMINDER_DEFAULTS.snoozeMinutes),
        clampInt(reminder.followupMinutes, 1, 240, REMINDER_DEFAULTS.followupMinutes),
        clampInt(reminder.followupCount, 0, 5, REMINDER_DEFAULTS.followupCount));
    }
    // Reminder rows are recreated with fresh ids, so any journal entry still waiting on the
    // old ids can never be resolved. Drop those rather than let them age into false misses.
    await transaction.runAsync("DELETE FROM reminder_deliveries WHERE habit_id = ? AND state = 'scheduled'", habitId);
  });
}
export async function updatePrimaryReminder(habitId: number, hour: number, minute: number, enabled: boolean) { const db = await getDatabase(); const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM habit_reminders WHERE habit_id = ? ORDER BY id LIMIT 1', habitId); if (existing) await db.runAsync('UPDATE habit_reminders SET hour = ?, minute = ?, enabled = ? WHERE id = ?', hour, minute, enabled ? 1 : 0, existing.id); else await db.runAsync('INSERT INTO habit_reminders(habit_id, hour, minute, enabled) VALUES (?, ?, ?, ?)', habitId, hour, minute, enabled ? 1 : 0); }
export type EnabledReminder = { id: number; habitId: number; name: string; hour: number; minute: number; dailyGoal: number; habitType: HabitType; todayCount: number; label: string | null; body: string | null; snoozeMinutes: number; followupMinutes: number; followupCount: number };
export async function getEnabledReminders(entryDate: string) { const db = await getDatabase(); return db.getAllAsync<EnabledReminder>(`SELECT r.id, r.habit_id AS habitId, h.name, r.hour, r.minute, h.daily_goal AS dailyGoal, h.habit_type AS habitType,
  r.label, r.body, r.snooze_minutes AS snoozeMinutes, r.followup_minutes AS followupMinutes, r.followup_count AS followupCount,
  COALESCE((SELECT completion_count FROM habit_entries e WHERE e.habit_id = h.id AND e.entry_date = ?), 0) AS todayCount
  FROM habit_reminders r JOIN habits h ON h.id = r.habit_id WHERE r.enabled = 1 AND h.archived_at IS NULL ORDER BY r.hour, r.minute, r.id`, entryDate); }
export async function setReminderNotificationId(reminderId: number, notificationId: string) { const db = await getDatabase(); await db.runAsync('UPDATE habit_reminders SET notification_id = ? WHERE id = ?', notificationId, reminderId); }

/**
 * Delivery journal. `occurrence_at` is the wall-clock moment the app asked Android for,
 * which is what makes "Android never delivered the 11:00 dose" a provable statement
 * instead of a hunch.
 */
export async function recordExpectedDelivery(entry: { reminderId: number; habitId: number; occurrenceAt: string; kind: DeliveryKind; identifier: string }) {
  const db = await getDatabase();
  await db.runAsync(`INSERT INTO reminder_deliveries(reminder_id, habit_id, occurrence_at, kind, identifier) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(reminder_id, occurrence_at, kind) DO UPDATE SET identifier = excluded.identifier`,
    entry.reminderId, entry.habitId, entry.occurrenceAt, entry.kind, entry.identifier);
}

/** Resolves the single occurrence an incoming notification belongs to: the nearest one to now. */
async function currentOccurrenceId(identifier: string, atIso: string) {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM reminder_deliveries WHERE identifier = ? ORDER BY ABS(strftime('%s', occurrence_at) - strftime('%s', ?)) LIMIT 1`, identifier, atIso);
  return row?.id ?? null;
}

export async function markDeliveryDelivered(identifier: string, atIso: string) {
  const db = await getDatabase();
  const id = await currentOccurrenceId(identifier, atIso);
  if (id === null) return;
  await db.runAsync("UPDATE reminder_deliveries SET state = CASE WHEN state = 'acted' THEN 'acted' ELSE 'delivered' END, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?", atIso, id);
}

export async function markDeliveryActed(identifier: string, action: string, atIso: string) {
  const db = await getDatabase();
  const id = await currentOccurrenceId(identifier, atIso);
  if (id === null) return;
  await db.runAsync("UPDATE reminder_deliveries SET state = 'acted', delivered_at = COALESCE(delivered_at, ?), acted_at = ?, action = ? WHERE id = ?", atIso, atIso, action, id);
}

/**
 * Closes out every occurrence whose moment has passed without a delivery callback and
 * returns them. They are recorded as `unconfirmed`, not `missed`: the received-listener
 * only fires while the JavaScript process is alive, so silence proves the app could not
 * observe the delivery, never that Android failed to make it. The user-facing safety net
 * runs off getOverdueReminders instead, which needs no such inference.
 */
export async function sweepUnconfirmedDeliveries(nowIso: string, deliveredIdentifiers: string[] = [], graceSeconds = 180): Promise<ReminderDelivery[]> {
  const db = await getDatabase();
  const cutoff = new Date(Date.parse(nowIso) - graceSeconds * 1000).toISOString();
  // Anything still sitting in the notification tray demonstrably arrived.
  for (const identifier of deliveredIdentifiers) await markDeliveryDelivered(identifier, nowIso);
  const rows = await db.getAllAsync<ReminderDelivery>(`SELECT d.id, d.reminder_id AS reminderId, d.habit_id AS habitId, COALESCE(h.name, 'Deleted habit') AS habitName,
    d.occurrence_at AS occurrenceAt, d.kind, d.identifier, d.state, d.delivered_at AS deliveredAt, d.acted_at AS actedAt, d.action
    FROM reminder_deliveries d LEFT JOIN habits h ON h.id = d.habit_id
    WHERE d.state = 'scheduled' AND d.occurrence_at <= ?`, cutoff);
  if (rows.length > 0) await db.runAsync(`UPDATE reminder_deliveries SET state = 'unconfirmed' WHERE state = 'scheduled' AND occurrence_at <= ?`, cutoff);
  await db.runAsync('DELETE FROM reminder_deliveries WHERE id NOT IN (SELECT id FROM reminder_deliveries ORDER BY id DESC LIMIT 2000)');
  return rows.map((row) => ({ ...row, state: 'unconfirmed' as const }));
}

/**
 * Claims today's catch-up slot for a reminder. The UNIQUE index does the work: only the
 * first call for a given occurrence reports a change, so at most one catch-up per day.
 */
export async function getCatchupClaim(reminderId: number, habitId: number, occurrenceIso: string, identifier: string) {
  const db = await getDatabase();
  const result = await db.runAsync(`INSERT OR IGNORE INTO reminder_deliveries(reminder_id, habit_id, occurrence_at, kind, identifier, state, delivered_at)
    VALUES (?, ?, ?, 'catchup', ?, 'delivered', ?)`, reminderId, habitId, occurrenceIso, identifier, new Date().toISOString());
  return { changes: result.changes };
}

export async function getRecentDeliveries(limit = 60) {
  const db = await getDatabase();
  return db.getAllAsync<ReminderDelivery>(`SELECT d.id, d.reminder_id AS reminderId, d.habit_id AS habitId, COALESCE(h.name, 'Deleted habit') AS habitName,
    d.occurrence_at AS occurrenceAt, d.kind, d.identifier, d.state, d.delivered_at AS deliveredAt, d.acted_at AS actedAt, d.action
    FROM reminder_deliveries d LEFT JOIN habits h ON h.id = d.habit_id ORDER BY d.occurrence_at DESC LIMIT ?`, limit);
}

/** Reminders whose time passed today while the habit is still short of its target (or unlogged for unlimited habits). */
export async function getOverdueReminders(entryDate: string, nowMinutes: number) {
  const db = await getDatabase();
  return db.getAllAsync<{ id: number; habitId: number; name: string; hour: number; minute: number; dailyGoal: number; todayCount: number }>(
    `SELECT r.id, r.habit_id AS habitId, h.name, r.hour, r.minute, h.daily_goal AS dailyGoal,
      COALESCE((SELECT completion_count FROM habit_entries e WHERE e.habit_id = h.id AND e.entry_date = ?), 0) AS todayCount
      FROM habit_reminders r JOIN habits h ON h.id = r.habit_id
      WHERE r.enabled = 1 AND h.archived_at IS NULL AND (r.hour * 60 + r.minute) <= ?
      AND COALESCE((SELECT completion_count FROM habit_entries e WHERE e.habit_id = h.id AND e.entry_date = ?), 0) < CASE WHEN h.habit_type = 'unlimited' THEN 1 ELSE h.daily_goal END
      ORDER BY r.hour, r.minute`, entryDate, nowMinutes, entryDate);
}

export async function addDiagnosticLog(level: DiagnosticLog['level'], step: string, message: string, details?: unknown) {
  const db = await getDatabase();
  let serialized: string | null = null;
  if (details !== undefined) {
    try { serialized = typeof details === 'string' ? details : JSON.stringify(details); } catch { serialized = String(details); }
  }
  const createdAt = new Date().toISOString();
  // Mirrored to disk first: if the process dies mid-write, the file line still survives.
  appendFileLog(`${createdAt} [${level}] ${step} ${message}${serialized ? ` ${serialized.slice(0, 2000)}` : ''}`);
  await db.runAsync('INSERT INTO diagnostic_logs(created_at, level, step, message, details) VALUES (?, ?, ?, ?, ?)', createdAt, level, step.slice(0, 80), message.slice(0, 500), serialized?.slice(0, 10_000) ?? null);
  await db.runAsync('DELETE FROM diagnostic_logs WHERE id NOT IN (SELECT id FROM diagnostic_logs ORDER BY id DESC LIMIT 1000)');
}
export async function getDiagnosticLogs() { const db = await getDatabase(); return db.getAllAsync<DiagnosticLog>('SELECT id, created_at AS createdAt, level, step, message, details FROM diagnostic_logs ORDER BY id DESC LIMIT 1000'); }
export async function clearDiagnosticLogs() { const db = await getDatabase(); await db.runAsync('DELETE FROM diagnostic_logs'); }

export async function createBackup(): Promise<HabbitDotBackup> {
  const db = await getDatabase();
  const habits = await db.getAllAsync<{ id: number; name: string; color: string; createdAt: string; archivedAt: string | null; dailyGoal: number; habitType: HabitType }>('SELECT id, name, color, created_at AS createdAt, archived_at AS archivedAt, daily_goal AS dailyGoal, habit_type AS habitType FROM habits ORDER BY id');
  const entries = await db.getAllAsync<{ habitId: number; entryDate: string; completedAt: string; completionCount: number }>('SELECT habit_id AS habitId, entry_date AS entryDate, completed_at AS completedAt, completion_count AS completionCount FROM habit_entries ORDER BY habit_id, entry_date');
  const reminderRows = await db.getAllAsync<{ id: number; habitId: number; hour: number; minute: number; enabled: number; label: string | null; body: string | null; snoozeMinutes: number; followupMinutes: number; followupCount: number }>(`SELECT id, habit_id AS habitId, hour, minute, enabled, label, body,
    snooze_minutes AS snoozeMinutes, followup_minutes AS followupMinutes, followup_count AS followupCount FROM habit_reminders ORDER BY id`);
  const settings = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM app_settings ORDER BY key');
  return { format: 'habbitdot-backup', version: 1, exportedAt: new Date().toISOString(), habits, entries, reminders: reminderRows.map((item) => ({ ...item, enabled: Boolean(item.enabled) })), settings };
}

const isIntegerBetween = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const isIsoDateTime = (value: unknown) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

export function parseBackup(text: string): HabbitDotBackup {
  if (text.length > 10_000_000) throw new Error('Backup is larger than the 10 MB safety limit.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('This is not valid JSON.'); }
  const backup = value as Partial<HabbitDotBackup>;
  if (!backup || backup.format !== 'habbitdot-backup' || backup.version !== 1) throw new Error('This is not a supported HabbitDot backup.');
  if (!Array.isArray(backup.habits) || !Array.isArray(backup.entries) || !Array.isArray(backup.reminders) || !Array.isArray(backup.settings)) throw new Error('The backup is missing required data.');
  if (backup.habits.length > 1000 || backup.entries.length > 1_000_000 || backup.reminders.length > 10_000 || backup.settings.length > 1000) throw new Error('The backup contains too many records.');
  const habitIds = new Set<number>();
  for (const habit of backup.habits) {
    if (!isIntegerBetween(habit?.id, 1, 2_147_483_647) || habitIds.has(habit.id)) throw new Error('The backup contains an invalid or duplicate habit ID.');
    if (typeof habit.name !== 'string' || !habit.name.trim() || habit.name.length > 200 || typeof habit.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(habit.color) || !isIsoDateTime(habit.createdAt) || (habit.archivedAt !== null && !isIsoDateTime(habit.archivedAt)) || !isIntegerBetween(habit.dailyGoal, 1, 20) || (habit.habitType != null && habit.habitType !== 'target' && habit.habitType !== 'unlimited')) throw new Error(`Habit ${habit.id} is invalid.`);
    habitIds.add(habit.id);
  }
  const entryKeys = new Set<string>();
  for (const entry of backup.entries) {
    const key = `${entry?.habitId}:${entry?.entryDate}`;
    if (!habitIds.has(entry?.habitId) || typeof entry.entryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.entryDate) || Number.isNaN(Date.parse(`${entry.entryDate}T00:00:00`)) || !isIsoDateTime(entry.completedAt) || !isIntegerBetween(entry.completionCount, 1, 1_000_000) || entryKeys.has(key)) throw new Error('The backup contains an invalid or duplicate check-in.');
    entryKeys.add(key);
  }
  const reminderIds = new Set<number>();
  for (const reminder of backup.reminders) {
    if (!isIntegerBetween(reminder?.id, 1, 2_147_483_647) || reminderIds.has(reminder.id) || !habitIds.has(reminder.habitId) || !isIntegerBetween(reminder.hour, 0, 23) || !isIntegerBetween(reminder.minute, 0, 59) || typeof reminder.enabled !== 'boolean') throw new Error('The backup contains an invalid reminder.');
    for (const key of ['label', 'body'] as const) if (reminder[key] != null && (typeof reminder[key] !== 'string' || (reminder[key] as string).length > 120)) throw new Error(`Reminder ${reminder.id} has an invalid ${key}.`);
    if (reminder.snoozeMinutes != null && !isIntegerBetween(reminder.snoozeMinutes, 1, 240)) throw new Error(`Reminder ${reminder.id} has an invalid snooze interval.`);
    if (reminder.followupMinutes != null && !isIntegerBetween(reminder.followupMinutes, 1, 240)) throw new Error(`Reminder ${reminder.id} has an invalid follow-up interval.`);
    if (reminder.followupCount != null && !isIntegerBetween(reminder.followupCount, 0, 5)) throw new Error(`Reminder ${reminder.id} has an invalid follow-up count.`);
    reminderIds.add(reminder.id);
  }
  const settingKeys = new Set<string>();
  for (const setting of backup.settings) {
    if (typeof setting?.key !== 'string' || !setting.key || setting.key.length > 200 || settingKeys.has(setting.key) || typeof setting.value !== 'string' || setting.value.length > 10_000) throw new Error('The backup contains an invalid setting.');
    settingKeys.add(setting.key);
  }
  return backup as HabbitDotBackup;
}

export async function restoreBackup(backup: HabbitDotBackup) {
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync('DELETE FROM habit_entries; DELETE FROM habit_reminders; DELETE FROM habits; DELETE FROM app_settings; DELETE FROM reminder_deliveries;');
    for (const habit of backup.habits) await transaction.runAsync('INSERT INTO habits(id, name, color, created_at, archived_at, daily_goal, habit_type) VALUES (?, ?, ?, ?, ?, ?, ?)', habit.id, habit.name.trim(), habit.color, habit.createdAt, habit.archivedAt, habit.dailyGoal, habit.habitType ?? 'target');
    for (const entry of backup.entries) await transaction.runAsync('INSERT INTO habit_entries(habit_id, entry_date, completed_at, completion_count) VALUES (?, ?, ?, ?)', entry.habitId, entry.entryDate, entry.completedAt, entry.completionCount);
    for (const reminder of backup.reminders) await transaction.runAsync('INSERT INTO habit_reminders(id, habit_id, hour, minute, enabled, notification_id, label, body, snooze_minutes, followup_minutes, followup_count) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      reminder.id, reminder.habitId, reminder.hour, reminder.minute, reminder.enabled ? 1 : 0, trimOrNull(reminder.label), trimOrNull(reminder.body),
      clampInt(reminder.snoozeMinutes, 1, 240, REMINDER_DEFAULTS.snoozeMinutes),
      clampInt(reminder.followupMinutes, 1, 240, REMINDER_DEFAULTS.followupMinutes),
      clampInt(reminder.followupCount, 0, 5, REMINDER_DEFAULTS.followupCount));
    for (const setting of backup.settings) await transaction.runAsync('INSERT INTO app_settings(key, value) VALUES (?, ?)', setting.key, setting.value);
  });
}
