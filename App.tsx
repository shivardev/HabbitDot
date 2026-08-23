import { StatusBar } from 'expo-status-bar';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { addHabit, getHabits, getSetting, Habit, initializeDatabase, replaceHabitReminders, setSetting, toggleEntry, updateDailyGoal, updateHabit, updatePrimaryReminder } from './src/database';
import { configureNotifications, listenForNotificationActions, scheduleDeliveryVerification } from './src/notifications';
import { AnalyticsScreen } from './src/AnalyticsScreen';

const COLORS = ['#B7F171', '#B79CFF', '#FFB86B', '#7CE7D5', '#FF91AF', '#FF5D62', '#F3C51D', '#2DB26B', '#4CA9D8', '#2D82B7', '#CE1981', '#8D49B0'];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function progressColor(color: string, count: number, goal: number) {
  if (count <= 0) return `${color}30`;
  if (count >= Math.max(1, goal)) return color;
  const ratio = count / Math.max(1, goal);
  const alpha = Math.round(0x30 + ratio * (0xff - 0x30));
  return `${color}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
}

function historyWeeks(count = 26) {
  const today = new Date();
  const monday = new Date(today);
  const dayOffset = (today.getDay() + 6) % 7;
  monday.setDate(today.getDate() - dayOffset - (count - 1) * 7);
  return Array.from({ length: count }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + week * 7 + weekday);
      return { key: dateKey(date), future: date > today };
    }),
  );
}

function HabitCard({ habit, onToggle, onOpen }: { habit: Habit; onToggle: (habitId: number, date: string) => void; onOpen: (habit: Habit) => void }) {
  const weeks = useMemo(() => historyWeeks(), []);
  const today = dateKey(new Date());
  const todayComplete = habit.completedDates.includes(today);
  const todayCount = habit.completionCounts[today] ?? 0;
  const todayRatio = todayCount / Math.max(1, habit.dailyGoal);
  const completed = new Set(habit.completedDates);
  const total = habit.completedDates.length;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.habitIcon, { backgroundColor: `${habit.color}28` }]}>
          <View style={[styles.iconDot, { borderColor: habit.color }]} />
        </View>
        <View style={styles.habitIdentity}>
          <Text numberOfLines={1} style={styles.habitName}>{habit.name.toUpperCase()}</Text>
          <Text style={styles.habitMeta}>DAILY · LOCAL</Text>
        </View>
        <Pressable accessibilityLabel={`${todayComplete ? 'Uncheck' : 'Complete'} ${habit.name} today`} accessibilityRole="button" onPress={() => onToggle(habit.id, today)} style={({ pressed }) => [styles.todayButton, { backgroundColor: progressColor(habit.color, todayCount, habit.dailyGoal), borderColor: `${habit.color}70` }, pressed && styles.pressed]}>
          <Text style={[styles.todayCheck, { color: todayRatio >= 0.65 ? '#101012' : habit.color }, todayComplete && styles.todayCheckActive]}>{habit.dailyGoal > 1 ? `${todayCount}/${habit.dailyGoal}` : todayComplete ? '✓' : '+'}</Text>
        </Pressable>
      </View>

      <View style={[styles.statsStrip, { backgroundColor: `${habit.color}26` }]}>
        <Text style={styles.statText}>● {habit.currentStreak} DAY STREAK</Text>
        <Text style={styles.statText}>{total} DAYS  ·  GOAL {habit.dailyGoal}×</Text>
      </View>

      <View style={styles.historyRow}>
        <View style={styles.weekdayLabels}>{WEEKDAYS.map((day, index) => <Text key={`${day}-${index}`} style={styles.weekday}>{day}</Text>)}</View>
        <View style={styles.weeks}>
          {weeks.map((week, weekIndex) => (
            <View key={weekIndex} style={styles.weekColumn}>
              {week.map((day) => {
                const count = habit.completionCounts[day.key] ?? 0;
                const done = completed.has(day.key);
                return <Pressable key={day.key} accessibilityLabel={`Open ${habit.name} history at ${day.key}, ${count} of ${habit.dailyGoal}`} disabled={day.future} onPress={() => onOpen(habit)} style={({ pressed }) => [styles.historyDot, { backgroundColor: progressColor(habit.color, count, habit.dailyGoal) }, day.future && styles.futureDot, pressed && styles.pressed]} />;
              })}
            </View>
          ))}
        </View>
      </View>
      <View style={styles.monthLabels}><Text style={styles.monthLabel}>MAR</Text><Text style={styles.monthLabel}>APR</Text><Text style={styles.monthLabel}>MAY</Text><Text style={styles.monthLabel}>JUN</Text><Text style={styles.monthLabel}>JUL</Text><Text style={styles.monthLabel}>AUG</Text></View>
    </View>
  );
}

function calendarDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { key: dateKey(date), day: date.getDate(), inMonth: date.getMonth() === month.getMonth(), future: date > new Date() };
  });
}

function HabitDetail({ habit, month, onChangeMonth, onClose, onEdit, onGoal, onReminder, onToggle }: { habit: Habit; month: Date; onChangeMonth: (offset: number) => void; onClose: () => void; onEdit: () => void; onGoal: (goal: number) => void; onReminder: (hour: number, minute: number, enabled: boolean) => void; onToggle: (habitId: number, date: string) => void }) {
  const weeks = useMemo(() => historyWeeks(), []);
  const days = useMemo(() => calendarDays(month), [month]);
  const completed = new Set(habit.completedDates);
  const reminderMinutes = (habit.reminderHour ?? 20) * 60 + (habit.reminderMinute ?? 0);
  const reminderLabel = new Date(2000, 0, 1, habit.reminderHour ?? 20, habit.reminderMinute ?? 0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const shiftReminder = (offset: number) => { const next = (reminderMinutes + offset + 1440) % 1440; onReminder(Math.floor(next / 60), next % 60, habit.reminderEnabled); };
  return <Modal animationType="slide" onRequestClose={onClose} transparent visible>
    <View style={styles.modalBackdrop}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.detailSheet}>
        <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
          <View style={styles.detailHeader}>
            <View style={[styles.detailIcon, { backgroundColor: `${habit.color}2A` }]}><View style={[styles.iconDot, { borderColor: habit.color }]} /></View>
            <View style={styles.habitIdentity}><Text style={styles.detailName}>{habit.name.toUpperCase()}</Text><Text style={styles.habitMeta}>HABIT HISTORY</Text></View>
            <Pressable accessibilityLabel={`Edit ${habit.name}`} onPress={onEdit} style={styles.editButton}><Text style={styles.editButtonText}>✎</Text></Pressable>
            <Pressable accessibilityLabel="Close habit details" onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
          </View>

          <View style={[styles.statsStrip, { backgroundColor: `${habit.color}26` }]}><Text style={styles.statText}>● {habit.currentStreak} DAY STREAK</Text><Text style={styles.statText}>{habit.completedDates.length} CHECK-INS</Text></View>
          <View style={styles.reminderSettings}>
            <View style={styles.settingLine}><View><Text style={styles.settingTitle}>DAILY TARGET</Text><Text style={styles.settingHint}>Incremental check-ins</Text></View><View style={styles.stepper}><Pressable onPress={() => onGoal(habit.dailyGoal - 1)} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><Text style={styles.stepValue}>{habit.dailyGoal}×</Text><Pressable onPress={() => onGoal(habit.dailyGoal + 1)} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable></View></View>
            <View style={styles.settingDivider} />
            <View style={styles.settingLine}><Pressable onPress={() => onReminder(habit.reminderHour ?? 20, habit.reminderMinute ?? 0, !habit.reminderEnabled)}><Text style={styles.settingTitle}>REMINDER {habit.reminderEnabled ? 'ON' : 'OFF'}</Text><Text style={styles.settingHint}>Tap label to toggle</Text></Pressable><View style={styles.stepper}><Pressable onPress={() => shiftReminder(-15)} style={styles.stepButton}><Text style={styles.stepText}>‹</Text></Pressable><Text style={styles.reminderTime}>{reminderLabel}</Text><Pressable onPress={() => shiftReminder(15)} style={styles.stepButton}><Text style={styles.stepText}>›</Text></Pressable></View></View>
          </View>
          <View style={styles.overviewBox}>
            <View style={styles.historyRow}><View style={styles.weekdayLabels}>{WEEKDAYS.map((day, index) => <Text key={`${day}-${index}`} style={styles.weekday}>{day}</Text>)}</View><View style={styles.weeks}>{weeks.map((week, weekIndex) => <View key={weekIndex} style={styles.weekColumn}>{week.map((day) => { const count = habit.completionCounts[day.key] ?? 0; return <View key={day.key} style={[styles.historyDot, { backgroundColor: progressColor(habit.color, count, habit.dailyGoal) }, day.future && styles.futureDot]} />; })}</View>)}</View></View>
            <View style={styles.monthLabels}><Text style={styles.monthLabel}>MAR</Text><Text style={styles.monthLabel}>APR</Text><Text style={styles.monthLabel}>MAY</Text><Text style={styles.monthLabel}>JUN</Text><Text style={styles.monthLabel}>JUL</Text><Text style={styles.monthLabel}>AUG</Text></View>
          </View>

          <View style={styles.calendarBox}>
            <View style={styles.calendarWeek}>{WEEKDAYS.map((day, index) => <Text key={`${day}-${index}`} style={styles.calendarWeekday}>{day}</Text>)}</View>
            <View style={styles.calendarGrid}>{days.map((day) => {
              const count = habit.completionCounts[day.key] ?? 0;
              const done = count >= habit.dailyGoal;
              return <Pressable key={day.key} accessibilityLabel={`${habit.name}, ${day.key}, ${count} of ${habit.dailyGoal}`} disabled={!day.inMonth || day.future} onPress={() => onToggle(habit.id, day.key)} style={({ pressed }) => [styles.calendarCell, !day.inMonth && styles.calendarOutside, count > 0 && { backgroundColor: progressColor(habit.color, count, habit.dailyGoal), borderColor: habit.color }, pressed && styles.pressed]}><Text style={[styles.calendarDay, count > 0 && { color: count >= habit.dailyGoal ? '#111114' : '#F4F4F2' }]}>{day.day}</Text><Text style={[styles.calendarState, count > 0 && { color: count >= habit.dailyGoal ? '#111114' : '#F4F4F2' }]}>{count}/{habit.dailyGoal}</Text></Pressable>;
            })}</View>
          </View>
          <View style={styles.monthControls}><Pressable accessibilityLabel="Previous month" onPress={() => onChangeMonth(-1)} style={styles.monthArrow}><Text style={styles.monthArrowText}>‹</Text></Pressable><View style={styles.monthName}><Text style={styles.monthNameText}>{month.toLocaleDateString(undefined, { month: 'long' }).toUpperCase()}</Text></View><View style={styles.yearBox}><Text style={styles.monthNameText}>{month.getFullYear()}</Text></View><Pressable accessibilityLabel="Next month" onPress={() => onChangeMonth(1)} style={styles.monthArrow}><Text style={styles.monthArrowText}>›</Text></Pressable></View>
        </ScrollView>
      </SafeAreaView>
    </View>
  </Modal>;
}

type EditableReminder = { key: string; hour: number; minute: number; enabled: boolean };
const formatTime = (hour: number, minute: number) => new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function openTimePicker(hour: number, minute: number, onSelect: (hour: number, minute: number) => void) {
  DateTimePickerAndroid.open({
    value: new Date(2000, 0, 1, hour, minute),
    mode: 'time',
    is24Hour: false,
    minuteInterval: 1,
    onChange: (event, selectedTime) => {
      if (event.type === 'set' && selectedTime) onSelect(selectedTime.getHours(), selectedTime.getMinutes());
    },
  });
}

function EditHabit({ habit, onClose, onSave }: { habit: Habit; onClose: () => void; onSave: (name: string, color: string, goal: number, reminders: EditableReminder[]) => Promise<void> }) {
  const [draftName, setDraftName] = useState(habit.name);
  const [color, setColor] = useState(habit.color);
  const [goal, setGoal] = useState(habit.dailyGoal);
  const [saving, setSaving] = useState(false);
  const [reminders, setReminders] = useState<EditableReminder[]>(() => habit.reminders.map((item) => ({ ...item, key: String(item.id) })));
  const setReminderTime = (key: string, hour: number, minute: number) => setReminders((items) => items.map((item) => item.key === key ? { ...item, hour, minute } : item));
  const save = async () => { if (!draftName.trim() || saving) return; setSaving(true); try { await onSave(draftName.trim(), color, goal, reminders); } finally { setSaving(false); } };
  return <Modal animationType="slide" onRequestClose={onClose} visible>
    <SafeAreaView edges={['top', 'bottom']} style={styles.editScreen}>
      <View style={styles.editHeader}><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.editBack}>‹</Text></Pressable><Text style={styles.editTitle}>EDIT HABIT</Text><Pressable onPress={save} style={[styles.editDone, saving && styles.disabled]}><Text style={styles.editDoneText}>✓</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.editContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.editLabel}>HABIT NAME</Text>
        <TextInput onChangeText={setDraftName} placeholder="NAME YOUR HABIT" placeholderTextColor="#67676D" style={styles.editInput} value={draftName} />
        <Text style={styles.editLabel}>COLOR</Text>
        <View style={styles.colorGrid}>{COLORS.map((option) => <Pressable accessibilityLabel={`Use color ${option}`} key={option} onPress={() => setColor(option)} style={[styles.colorChoice, { backgroundColor: option }, color === option && styles.colorSelected]}>{color === option && <Text style={styles.colorCheck}>✓</Text>}</Pressable>)}</View>
        <Text style={styles.editLabel}>HOW MANY TIMES PER DAY?</Text>
        <View style={styles.goalEditor}><View><Text style={styles.goalNumber}>{goal}×</Text><Text style={styles.settingHint}>Each notification action increments progress</Text></View><View style={styles.stepper}><Pressable onPress={() => setGoal(Math.max(1, goal - 1))} style={styles.largeStep}><Text style={styles.stepText}>−</Text></Pressable><Pressable onPress={() => setGoal(Math.min(20, goal + 1))} style={styles.largeStep}><Text style={styles.stepText}>+</Text></Pressable></View></View>
        <View style={styles.reminderHeading}><View><Text style={styles.editLabelNoMargin}>REMINDERS</Text><Text style={styles.settingHint}>Choose every time you want to be notified</Text></View><Pressable accessibilityLabel="Add reminder" onPress={() => setReminders((items) => [...items, { key: `${Date.now()}`, hour: 9, minute: 0, enabled: true }])} style={styles.addReminder}><Text style={styles.addReminderText}>+</Text></Pressable></View>
        {reminders.length === 0 && <View style={styles.noReminders}><Text style={styles.noRemindersTitle}>NO REMINDERS</Text><Text style={styles.settingHint}>Tap + to add a notification time.</Text></View>}
        {reminders.map((reminder, index) => <View key={reminder.key} style={styles.reminderRow}>
          <Pressable onPress={() => setReminders((items) => items.map((item) => item.key === reminder.key ? { ...item, enabled: !item.enabled } : item))} style={[styles.reminderToggle, reminder.enabled && { backgroundColor: color }]}><View style={[styles.toggleKnob, reminder.enabled && styles.toggleKnobOn]} /></Pressable>
          <View style={styles.reminderIdentity}><Text style={styles.reminderName}>REMINDER {index + 1}</Text><Text style={[styles.reminderBigTime, !reminder.enabled && styles.muted]}>{formatTime(reminder.hour, reminder.minute)}</Text></View>
          <Pressable accessibilityLabel={`Set reminder ${index + 1} time`} onPress={() => openTimePicker(reminder.hour, reminder.minute, (hour, minute) => setReminderTime(reminder.key, hour, minute))} style={styles.timePickerButton}><Text style={styles.timePickerIcon}>◷</Text><Text style={styles.timePickerLabel}>SET TIME</Text></Pressable>
          <Pressable accessibilityLabel={`Delete reminder ${index + 1}`} onPress={() => setReminders((items) => items.filter((item) => item.key !== reminder.key))} style={styles.deleteReminder}><Text style={styles.deleteReminderText}>×</Text></Pressable>
        </View>)}
        <Pressable disabled={!draftName.trim() || saving} onPress={save} style={[styles.saveHabitButton, (!draftName.trim() || saving) && styles.disabled]}><Text style={styles.saveHabitText}>{saving ? 'SAVING…' : 'SAVE HABIT'}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

export default function App() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [selectedHabitId, setSelectedHabitId] = useState<number | null>(null);
  const [editingHabitId, setEditingHabitId] = useState<number | null>(null);
  const [activeScreen, setActiveScreen] = useState<'habits' | 'analytics'>('habits');
  const [viewedMonth, setViewedMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const refresh = useCallback(async () => setHabits(await getHabits()), []);

  useEffect(() => {
    let notificationSubscription: { remove: () => void } | undefined;
    initializeDatabase().then(async () => {
      await refresh();
      const notificationReady = await configureNotifications();
      if (notificationReady) {
        notificationSubscription = (await listenForNotificationActions(refresh)) ?? undefined;
        if (await getSetting('notification_delivery_check') !== '2') {
          await scheduleDeliveryVerification();
          await setSetting('notification_delivery_check', '2');
        }
      }
    }).catch((error) => Alert.alert('Could not initialize HabbitDot', String(error))).finally(() => setLoading(false));
    return () => notificationSubscription?.remove();
  }, [refresh]);

  async function createHabit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await addHabit(trimmed, COLORS[habits.length % COLORS.length]);
    setName(''); setAdding(false); await refresh();
  }

  async function markDay(habitId: number, date: string) { await toggleEntry(habitId, date); await refresh(); if (date === dateKey(new Date())) await configureNotifications(); }
  async function changeGoal(habitId: number, goal: number) { await updateDailyGoal(habitId, goal); await refresh(); await configureNotifications(); }
  async function changeReminder(habitId: number, hour: number, minute: number, enabled: boolean) { await updatePrimaryReminder(habitId, hour, minute, enabled); await refresh(); await configureNotifications(); }
  async function saveHabitEdits(habitId: number, nextName: string, color: string, goal: number, reminders: EditableReminder[]) {
    await updateHabit(habitId, nextName, color, goal);
    await replaceHabitReminders(habitId, reminders.map(({ hour, minute, enabled }) => ({ hour, minute, enabled })));
    await refresh();
    await configureNotifications();
    setEditingHabitId(null);
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView edges={['top', 'right', 'left']} style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.screen}>
          {activeScreen === 'habits' ? <>
          <View style={styles.header}>
            <View><Text style={styles.brand}>HABIT <Text style={styles.brandAccent}>DOTS</Text></Text><Text style={styles.tagline}>SMALL MARKS. REAL MOMENTUM.</Text></View>
            <Pressable accessibilityLabel="Add habit" onPress={() => setAdding((value) => !value)} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}><Text style={styles.headerButtonText}>{adding ? '×' : '+'}</Text></Pressable>
          </View>

          <View style={styles.contextBar}><View><Text style={styles.contextEyebrow}>TODAY</Text><Text style={styles.contextDate}>{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}</Text></View><View style={styles.contextRule} /><Text style={styles.contextCount}>{habits.length} {habits.length === 1 ? 'HABIT' : 'HABITS'}</Text></View>

          {adding && <View style={styles.composer}><TextInput autoFocus onChangeText={setName} onSubmitEditing={createHabit} placeholder="NAME YOUR HABIT" placeholderTextColor="#77777E" returnKeyType="done" style={styles.input} value={name} /><Pressable disabled={!name.trim()} onPress={createHabit} style={[styles.saveButton, !name.trim() && styles.disabled]}><Text style={styles.saveText}>SAVE</Text></Pressable></View>}

          {loading ? <ActivityIndicator color="#B7F171" style={styles.loader} /> : (
            <FlatList contentContainerStyle={styles.list} data={habits} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <HabitCard habit={item} onOpen={(habit) => { setSelectedHabitId(habit.id); setViewedMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); }} onToggle={markDay} />} showsVerticalScrollIndicator={false}
              ListEmptyComponent={<View style={styles.empty}><View style={styles.emptyOrbit}><View style={styles.emptyCenter} /></View><Text style={styles.emptyTitle}>YOUR GRID IS READY</Text><Text style={styles.emptyBody}>Tap + to add a habit. Each day becomes a dot in your story.</Text></View>} />
          )}

          {selectedHabitId !== null && habits.find((habit) => habit.id === selectedHabitId) && <HabitDetail habit={habits.find((habit) => habit.id === selectedHabitId)!} month={viewedMonth} onChangeMonth={(offset) => setViewedMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1))} onClose={() => setSelectedHabitId(null)} onEdit={() => { setEditingHabitId(selectedHabitId); setSelectedHabitId(null); }} onGoal={(goal) => changeGoal(selectedHabitId, goal)} onReminder={(hour, minute, enabled) => changeReminder(selectedHabitId, hour, minute, enabled)} onToggle={markDay} />}
          {editingHabitId !== null && habits.find((habit) => habit.id === editingHabitId) && <EditHabit habit={habits.find((habit) => habit.id === editingHabitId)!} onClose={() => setEditingHabitId(null)} onSave={(nextName, color, goal, reminders) => saveHabitEdits(editingHabitId, nextName, color, goal, reminders)} />}
          </> : loading ? <ActivityIndicator color="#B7F171" style={styles.loader} /> : <AnalyticsScreen habits={habits} />}
          <View style={styles.bottomNav}>
            <Pressable accessibilityLabel="Habits" onPress={() => setActiveScreen('habits')} style={styles.navItem}><Text style={[styles.navIcon, activeScreen === 'habits' && styles.navActive]}>▦</Text><Text style={[styles.navLabel, activeScreen === 'habits' && styles.navActive]}>HABITS</Text></Pressable>
            <Pressable accessibilityLabel="Analytics" onPress={() => { setAdding(false); setActiveScreen('analytics'); }} style={styles.navItem}><Text style={[styles.navIcon, activeScreen === 'analytics' && styles.navActive]}>◔</Text><Text style={[styles.navLabel, activeScreen === 'analytics' && styles.navActive]}>ANALYTICS</Text></Pressable>
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0B0B0D' }, screen: { flex: 1, backgroundColor: '#0B0B0D' },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 9 }, brand: { color: '#F4F4F2', fontFamily: 'monospace', fontSize: 18, fontWeight: '900', letterSpacing: 2 }, brandAccent: { color: '#B7F171' }, tagline: { color: '#67676E', fontFamily: 'monospace', fontSize: 6, fontWeight: '800', letterSpacing: 1.5, marginTop: 2 }, headerButton: { alignItems: 'center', backgroundColor: '#ECECEA', borderRadius: 9, height: 34, justifyContent: 'center', width: 38 }, headerButtonText: { color: '#101012', fontFamily: 'monospace', fontSize: 21, fontWeight: '400', marginTop: -2 },
  contextBar: { alignItems: 'center', borderBottomColor: '#202024', borderBottomWidth: 1, borderTopColor: '#202024', borderTopWidth: 1, flexDirection: 'row', gap: 10, marginBottom: 4, paddingHorizontal: 16, paddingVertical: 8 }, contextEyebrow: { color: '#66666D', fontFamily: 'monospace', fontSize: 5, fontWeight: '900', letterSpacing: 1.3 }, contextDate: { color: '#E8E8E6', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', letterSpacing: 0.8, marginTop: 1 }, contextRule: { backgroundColor: '#2A2A2E', flex: 1, height: 1 }, contextCount: { color: '#77777E', fontFamily: 'monospace', fontSize: 6, fontWeight: '900', letterSpacing: 0.8 },
  composer: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, flexDirection: 'row', marginBottom: 5, marginHorizontal: 14, padding: 4 }, input: { color: '#F4F4F2', flex: 1, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, paddingHorizontal: 10 }, saveButton: { backgroundColor: '#B7F171', borderRadius: 8, justifyContent: 'center', paddingHorizontal: 13, paddingVertical: 8 }, saveText: { color: '#101012', fontSize: 9, fontWeight: '900' }, disabled: { opacity: 0.35 }, pressed: { opacity: 0.65, transform: [{ scale: 0.97 }] }, loader: { marginTop: 60 }, list: { flexGrow: 1, paddingBottom: 18, paddingHorizontal: 14, paddingTop: 5 },
  card: { backgroundColor: '#101012', borderColor: '#29292E', borderRadius: 10, borderWidth: 1, marginBottom: 8, padding: 9 }, cardHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 7 }, habitIcon: { alignItems: 'center', borderRadius: 8, height: 34, justifyContent: 'center', width: 38 }, iconDot: { borderRadius: 7, borderWidth: 2, height: 14, width: 14 }, habitIdentity: { flex: 1, marginLeft: 9 }, habitName: { color: '#F1F1EF', fontFamily: 'monospace', fontSize: 12, fontWeight: '900', letterSpacing: 0.9 }, habitMeta: { color: '#6E6E75', fontFamily: 'monospace', fontSize: 6, fontWeight: '800', letterSpacing: 1.1, marginTop: 2 }, todayButton: { alignItems: 'center', borderRadius: 8, borderWidth: 1, height: 34, justifyContent: 'center', width: 43 }, todayCheck: { fontFamily: 'monospace', fontSize: 14, fontWeight: '900' }, todayCheckActive: { fontSize: 15 }, statsStrip: { borderRadius: 4, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 7, paddingVertical: 4 }, statText: { color: '#E3E3E1', fontFamily: 'monospace', fontSize: 6, fontWeight: '900', letterSpacing: 0.3 }, historyRow: { flexDirection: 'row' }, weekdayLabels: { gap: 2, marginRight: 5 }, weekday: { color: '#707077', fontFamily: 'monospace', fontSize: 6, fontWeight: '800', height: 9, lineHeight: 9, textAlign: 'center', width: 8 }, weeks: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' }, weekColumn: { gap: 2 }, historyDot: { borderRadius: 5, height: 9, width: 9 }, futureDot: { backgroundColor: '#1D1D21', opacity: 0.65 }, monthLabels: { flexDirection: 'row', justifyContent: 'space-around', marginLeft: 13, marginTop: 5 }, monthLabel: { color: '#5F5F66', fontFamily: 'monospace', fontSize: 5, fontWeight: '800', letterSpacing: 0.7 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 48, paddingTop: 120 }, emptyOrbit: { alignItems: 'center', borderColor: '#B7F171', borderRadius: 36, borderWidth: 2, height: 72, justifyContent: 'center', width: 72 }, emptyCenter: { backgroundColor: '#B7F171', borderRadius: 8, height: 16, width: 16 }, emptyTitle: { color: '#F4F4F2', fontSize: 18, fontWeight: '900', letterSpacing: 1, marginTop: 22 }, emptyBody: { color: '#85858C', fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  bottomNav: { backgroundColor: '#111114', borderTopColor: '#242428', borderTopWidth: 1, bottom: 0, flexDirection: 'row', left: 0, paddingBottom: 8, paddingTop: 8, position: 'absolute', right: 0 }, navItem: { alignItems: 'center', flex: 1 }, navIcon: { color: '#68686F', fontSize: 13, height: 17 }, navLabel: { color: '#68686F', fontFamily: 'monospace', fontSize: 5, fontWeight: '900', letterSpacing: 0.7, marginTop: 2 }, navActive: { color: '#B7F171' },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.72)', flex: 1, justifyContent: 'flex-end' }, detailSheet: { backgroundColor: '#0B0B0D', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '90%' }, detailContent: { padding: 14, paddingBottom: 22 },
  detailHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 10 }, detailIcon: { alignItems: 'center', borderRadius: 10, height: 44, justifyContent: 'center', width: 48 }, detailName: { color: '#F4F4F2', fontSize: 17, fontWeight: '900', letterSpacing: 0.8 }, editButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 10, height: 40, justifyContent: 'center', marginRight: 6, width: 44 }, editButtonText: { color: '#F4F4F2', fontSize: 21 }, closeButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 10, height: 40, justifyContent: 'center', width: 44 }, closeText: { color: '#F4F4F2', fontSize: 25, lineHeight: 27 },
  overviewBox: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, marginBottom: 12, padding: 9 }, calendarBox: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, padding: 8 }, calendarWeek: { flexDirection: 'row', marginBottom: 6 }, calendarWeekday: { color: '#77777E', flex: 1, fontSize: 8, fontWeight: '900', textAlign: 'center' }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarCell: { alignItems: 'center', borderColor: '#29292E', borderRadius: 7, borderWidth: 1, height: 47, justifyContent: 'center', margin: '0.5%', width: '13.28%' }, calendarOutside: { borderColor: 'transparent', opacity: 0.16 }, calendarDay: { color: '#E6E6E4', fontSize: 12, fontWeight: '900' }, calendarState: { color: '#626269', fontSize: 5, fontWeight: '900', letterSpacing: 0.3, marginTop: 2 },
  monthControls: { flexDirection: 'row', gap: 7, marginTop: 11 }, monthArrow: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 9, height: 42, justifyContent: 'center', width: 46 }, monthArrowText: { color: '#F4F4F2', fontSize: 25 }, monthName: { alignItems: 'center', borderColor: '#303036', borderRadius: 9, borderWidth: 1, flex: 1, justifyContent: 'center' }, yearBox: { alignItems: 'center', borderColor: '#303036', borderRadius: 9, borderWidth: 1, justifyContent: 'center', width: 65 }, monthNameText: { color: '#F4F4F2', fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  reminderSettings: { borderColor: '#303036', borderRadius: 10, borderWidth: 1, marginBottom: 12, paddingHorizontal: 10 }, settingLine: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 54 }, settingTitle: { color: '#F4F4F2', fontSize: 9, fontWeight: '900', letterSpacing: 0.7 }, settingHint: { color: '#6F6F76', fontSize: 7, marginTop: 3 }, settingDivider: { backgroundColor: '#29292E', height: 1 }, stepper: { alignItems: 'center', flexDirection: 'row', gap: 7 }, stepButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 7, height: 30, justifyContent: 'center', width: 30 }, stepText: { color: '#F4F4F2', fontSize: 17, fontWeight: '700' }, stepValue: { color: '#B7F171', fontSize: 12, fontWeight: '900', minWidth: 28, textAlign: 'center' }, reminderTime: { color: '#B7F171', fontSize: 9, fontWeight: '900', minWidth: 62, textAlign: 'center' },
  editScreen: { backgroundColor: '#0B0B0D', flex: 1 }, editHeader: { alignItems: 'center', borderBottomColor: '#252529', borderBottomWidth: 1, flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12 }, editBack: { color: '#F4F4F2', fontSize: 29, lineHeight: 31 }, editTitle: { color: '#F4F4F2', flex: 1, fontSize: 20, fontWeight: '900', letterSpacing: 1.2 }, editDone: { alignItems: 'center', backgroundColor: '#F4F4F2', borderRadius: 10, height: 40, justifyContent: 'center', width: 44 }, editDoneText: { color: '#101012', fontSize: 20, fontWeight: '900' }, editContent: { padding: 18, paddingBottom: 42 }, editLabel: { color: '#DADAD8', fontSize: 10, fontWeight: '900', letterSpacing: 1, marginBottom: 10, marginTop: 20 }, editLabelNoMargin: { color: '#DADAD8', fontSize: 10, fontWeight: '900', letterSpacing: 1 }, editInput: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, color: '#F4F4F2', fontSize: 15, fontWeight: '800', letterSpacing: 0.5, paddingHorizontal: 14, paddingVertical: 14 }, colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, colorChoice: { alignItems: 'center', borderRadius: 10, height: 48, justifyContent: 'center', width: '22.9%' }, colorSelected: { borderColor: '#FFFFFF', borderWidth: 3 }, colorCheck: { color: '#FFFFFF', fontSize: 18, fontWeight: '900' }, goalEditor: { alignItems: 'center', borderColor: '#303036', borderRadius: 11, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', padding: 14 }, goalNumber: { color: '#F4F4F2', fontSize: 22, fontWeight: '900' }, largeStep: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 9, height: 42, justifyContent: 'center', width: 46 }, reminderHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, marginTop: 24 }, addReminder: { alignItems: 'center', backgroundColor: '#F4F4F2', borderRadius: 9, height: 38, justifyContent: 'center', width: 42 }, addReminderText: { color: '#101012', fontSize: 24 }, noReminders: { borderColor: '#303036', borderRadius: 11, borderStyle: 'dashed', borderWidth: 1, padding: 18 }, noRemindersTitle: { color: '#85858C', fontSize: 10, fontWeight: '900' }, reminderRow: { alignItems: 'center', borderColor: '#303036', borderRadius: 11, borderWidth: 1, flexDirection: 'row', gap: 7, marginBottom: 8, padding: 10 }, reminderToggle: { backgroundColor: '#34343A', borderRadius: 11, height: 22, padding: 3, width: 38 }, toggleKnob: { backgroundColor: '#F4F4F2', borderRadius: 8, height: 16, width: 16 }, toggleKnobOn: { alignSelf: 'flex-end' }, reminderIdentity: { flex: 1 }, reminderName: { color: '#73737A', fontSize: 6, fontWeight: '900', letterSpacing: 0.8 }, reminderBigTime: { color: '#F4F4F2', fontSize: 13, fontWeight: '900', marginTop: 2 }, timePickerButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 8, flexDirection: 'row', gap: 5, height: 34, justifyContent: 'center', paddingHorizontal: 9 }, timePickerIcon: { color: '#F4F4F2', fontSize: 17 }, timePickerLabel: { color: '#F4F4F2', fontSize: 7, fontWeight: '900', letterSpacing: 0.5 }, muted: { color: '#67676D' }, deleteReminder: { alignItems: 'center', height: 30, justifyContent: 'center', width: 25 }, deleteReminderText: { color: '#FF7780', fontSize: 22 }, saveHabitButton: { alignItems: 'center', backgroundColor: '#F4F4F2', borderRadius: 12, marginTop: 24, paddingVertical: 17 }, saveHabitText: { color: '#101012', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
});
