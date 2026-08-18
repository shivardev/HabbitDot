import * as SQLite from 'expo-sqlite';

export type ReminderTime = { id: number; hour: number; minute: number; enabled: boolean };
export type Habit = { id: number; name: string; color: string; createdAt: string; dailyGoal: number; reminderHour: number | null; reminderMinute: number | null; reminderEnabled: boolean; reminders: ReminderTime[]; completedDates: string[]; completionCounts: Record<string, number>; currentStreak: number };
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
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
  `);
  try { await db.execAsync('ALTER TABLE habits ADD COLUMN daily_goal INTEGER NOT NULL DEFAULT 1'); } catch {}
  try { await db.execAsync('ALTER TABLE habit_entries ADD COLUMN completion_count INTEGER NOT NULL DEFAULT 1'); } catch {}
  const finasterideRows = await db.getAllAsync<{ id: number }>("SELECT id FROM habits WHERE lower(trim(name)) = 'finasteride' AND archived_at IS NULL ORDER BY id DESC");
  if (finasterideRows.length > 1) {
    const keepId = finasterideRows[0].id;
    const duplicateList = finasterideRows.slice(1).map(({ id }) => id).join(',');
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        INSERT INTO habit_entries(habit_id, entry_date, completed_at, completion_count)
        SELECT ${keepId}, entry_date, MAX(completed_at), MAX(completion_count)
        FROM habit_entries WHERE habit_id IN (${keepId},${duplicateList}) GROUP BY entry_date
        ON CONFLICT(habit_id, entry_date) DO UPDATE SET
          completed_at = MAX(habit_entries.completed_at, excluded.completed_at),
          completion_count = MAX(habit_entries.completion_count, excluded.completion_count);
        DELETE FROM habits WHERE id IN (${duplicateList});
      `);
    });
  }
  const existingFinasteride = await db.getFirstAsync<{ id: number }>("SELECT id FROM habits WHERE lower(trim(name)) = 'finasteride' AND archived_at IS NULL LIMIT 1");
  if (!existingFinasteride) await db.runAsync("INSERT INTO habits(name, color, created_at, daily_goal) VALUES ('Finasteride', '#B7F171', ?, 1)", new Date().toISOString());
  const finasteride = existingFinasteride ?? await db.getFirstAsync<{ id: number }>("SELECT id FROM habits WHERE lower(trim(name)) = 'finasteride' AND archived_at IS NULL LIMIT 1");
  if (finasteride) await db.runAsync('INSERT INTO habit_reminders(habit_id, hour, minute, enabled) SELECT ?, 23, 30, 1 WHERE NOT EXISTS (SELECT 1 FROM habit_reminders WHERE habit_id = ?)', finasteride.id, finasteride.id);
}

type HabitRow = { id: number; name: string; color: string; createdAt: string; dailyGoal: number; reminderHour: number | null; reminderMinute: number | null; reminderEnabled: number };
type EntryRow = { habitId: number; entryDate: string; completionCount: number };
type ReminderRow = { id: number; habitId: number; hour: number; minute: number; enabled: number };
function streakFor(dates: string[]) {
  const completed = new Set(dates); const cursor = new Date(); let streak = 0;
  while (completed.has(cursor.toISOString().slice(0, 10))) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

export async function getHabits(): Promise<Habit[]> {
  const db = await getDatabase();
  const habits = await db.getAllAsync<HabitRow>(`SELECT h.id, h.name, h.color, h.created_at AS createdAt, h.daily_goal AS dailyGoal,
    (SELECT hour FROM habit_reminders WHERE habit_id = h.id ORDER BY id LIMIT 1) AS reminderHour,
    (SELECT minute FROM habit_reminders WHERE habit_id = h.id ORDER BY id LIMIT 1) AS reminderMinute,
    COALESCE((SELECT enabled FROM habit_reminders WHERE habit_id = h.id ORDER BY id LIMIT 1), 0) AS reminderEnabled
    FROM habits h WHERE h.archived_at IS NULL ORDER BY h.id DESC`);
  const entries = await db.getAllAsync<EntryRow>('SELECT habit_id AS habitId, entry_date AS entryDate, completion_count AS completionCount FROM habit_entries ORDER BY entry_date');
  const reminders = await db.getAllAsync<ReminderRow>('SELECT id, habit_id AS habitId, hour, minute, enabled FROM habit_reminders ORDER BY hour, minute, id');
  return habits.map((habit) => { const ownEntries = entries.filter((entry) => entry.habitId === habit.id); const ownReminders = reminders.filter((reminder) => reminder.habitId === habit.id).map(({ id, hour, minute, enabled }) => ({ id, hour, minute, enabled: Boolean(enabled) })); const completionCounts = Object.fromEntries(ownEntries.map((entry) => [entry.entryDate, entry.completionCount])); const completedDates = ownEntries.filter((entry) => entry.completionCount >= habit.dailyGoal).map((entry) => entry.entryDate); return { ...habit, reminderEnabled: Boolean(habit.reminderEnabled), reminders: ownReminders, completionCounts, completedDates, currentStreak: streakFor(completedDates) }; });
}

export async function addHabit(name: string, color: string) {
  const db = await getDatabase();
  await db.runAsync('INSERT INTO habits(name, color, created_at) VALUES (?, ?, ?)', name, color, new Date().toISOString());
}

export async function toggleEntry(habitId: number, entryDate: string) {
  const db = await getDatabase();
  const existing = await db.getFirstAsync<{ completionCount: number }>('SELECT completion_count AS completionCount FROM habit_entries WHERE habit_id = ? AND entry_date = ?', habitId, entryDate);
  const habit = await db.getFirstAsync<{ dailyGoal: number }>('SELECT daily_goal AS dailyGoal FROM habits WHERE id = ?', habitId);
  if (existing && existing.completionCount >= (habit?.dailyGoal ?? 1)) await db.runAsync('DELETE FROM habit_entries WHERE habit_id = ? AND entry_date = ?', habitId, entryDate);
  else if (existing) await db.runAsync('UPDATE habit_entries SET completion_count = completion_count + 1, completed_at = ? WHERE habit_id = ? AND entry_date = ?', new Date().toISOString(), habitId, entryDate);
  else await db.runAsync('INSERT INTO habit_entries(habit_id, entry_date, completed_at, completion_count) VALUES (?, ?, ?, 1)', habitId, entryDate, new Date().toISOString());
}

export async function incrementEntry(habitId: number, entryDate: string) {
  const db = await getDatabase();
  await db.runAsync(`INSERT INTO habit_entries(habit_id, entry_date, completed_at, completion_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(habit_id, entry_date) DO UPDATE SET completion_count = MIN(completion_count + 1, (SELECT daily_goal FROM habits WHERE id = ?)), completed_at = excluded.completed_at`, habitId, entryDate, new Date().toISOString(), habitId);
}

export async function getFinasterideHabit() { const db = await getDatabase(); return db.getFirstAsync<{ id: number; name: string }>("SELECT id, name FROM habits WHERE lower(name) = 'finasteride' LIMIT 1"); }
export async function getSetting(key: string) { const db = await getDatabase(); return (await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key))?.value ?? null; }
export async function setSetting(key: string, value: string) { const db = await getDatabase(); await db.runAsync('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }
export async function updateDailyGoal(habitId: number, dailyGoal: number) { const db = await getDatabase(); await db.runAsync('UPDATE habits SET daily_goal = ? WHERE id = ?', Math.max(1, Math.min(20, dailyGoal)), habitId); }
export async function updateHabit(habitId: number, name: string, color: string, dailyGoal: number) { const db = await getDatabase(); await db.runAsync('UPDATE habits SET name = ?, color = ?, daily_goal = ? WHERE id = ?', name.trim(), color, Math.max(1, Math.min(20, dailyGoal)), habitId); }
export async function replaceHabitReminders(habitId: number, reminders: Array<{ hour: number; minute: number; enabled: boolean }>) {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM habit_reminders WHERE habit_id = ?', habitId);
    for (const reminder of reminders) await db.runAsync('INSERT INTO habit_reminders(habit_id, hour, minute, enabled) VALUES (?, ?, ?, ?)', habitId, reminder.hour, reminder.minute, reminder.enabled ? 1 : 0);
  });
}
export async function updatePrimaryReminder(habitId: number, hour: number, minute: number, enabled: boolean) { const db = await getDatabase(); const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM habit_reminders WHERE habit_id = ? ORDER BY id LIMIT 1', habitId); if (existing) await db.runAsync('UPDATE habit_reminders SET hour = ?, minute = ?, enabled = ? WHERE id = ?', hour, minute, enabled ? 1 : 0, existing.id); else await db.runAsync('INSERT INTO habit_reminders(habit_id, hour, minute, enabled) VALUES (?, ?, ?, ?)', habitId, hour, minute, enabled ? 1 : 0); }
export async function getEnabledReminders(entryDate: string) { const db = await getDatabase(); return db.getAllAsync<{ id: number; habitId: number; name: string; hour: number; minute: number; dailyGoal: number; todayCount: number }>(`SELECT r.id, r.habit_id AS habitId, h.name, r.hour, r.minute, h.daily_goal AS dailyGoal,
  COALESCE((SELECT completion_count FROM habit_entries e WHERE e.habit_id = h.id AND e.entry_date = ?), 0) AS todayCount
  FROM habit_reminders r JOIN habits h ON h.id = r.habit_id WHERE r.enabled = 1 AND h.archived_at IS NULL`, entryDate); }
export async function setReminderNotificationId(reminderId: number, notificationId: string) { const db = await getDatabase(); await db.runAsync('UPDATE habit_reminders SET notification_id = ? WHERE id = ?', notificationId, reminderId); }
