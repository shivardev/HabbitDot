import { StatusBar } from 'expo-status-bar';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { addDiagnosticLog, addHabit, createBackup, decrementEntry, getHabits, getSetting, Habit, HabitType, initializeDatabase, parseBackup, REMINDER_DEFAULTS, replaceHabitReminders, restoreBackup, setSetting, toggleEntry, updateDailyGoal, updateHabit, updatePrimaryReminder } from './src/database';
import { configureNotifications, dismissRemindersFor, getLastOpenedHabitId, getMissedToday, listenForNotificationActions, NotificationHealth, notifyMissedReminders, scheduleDeliveryVerification } from './src/notifications';
import { MissedTodayBanner, ReminderHealthBanner } from './src/ReminderBanners';
import { openBatteryOptimizationSettings, openExactAlarmSettings, openNotificationSettings } from './modules/habbitdot-reliability';
import { AnalyticsScreen } from './src/AnalyticsScreen';
import { NotificationLogsScreen } from './src/NotificationLogsScreen';

const COLORS = ['#B7F171', '#B79CFF', '#FFB86B', '#7CE7D5', '#FF91AF', '#FF5D62', '#F3C51D', '#2DB26B', '#4CA9D8', '#2D82B7', '#CE1981', '#8D49B0'];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function progressColor(color: string, count: number, goal: number, unlimited = false) {
  if (count <= 0) return `${color}30`;
  if (unlimited) {
    const alpha = Math.round(0x30 + (0xff - 0x30) * (1 - Math.exp(-count / 3)));
    return `${color}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  if (count >= Math.max(1, goal)) return color;
  const ratio = count / Math.max(1, goal);
  const alpha = Math.round(0x30 + ratio * (0xff - 0x30));
  return `${color}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
}

function unlimitedDotLabel(count: number) {
  if (count <= 0) return null;
  return count < 10 ? String(count) : '+';
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

function HabitCard({ habit, onDecrement, onToggle, onOpen }: { habit: Habit; onDecrement: (habitId: number, date: string) => void; onToggle: (habitId: number, date: string) => void; onOpen: (habit: Habit) => void }) {
  const weeks = useMemo(() => historyWeeks(), []);
  const suppressPress = useRef(false);
  const today = dateKey(new Date());
  const todayComplete = habit.completedDates.includes(today);
  const todayCount = habit.completionCounts[today] ?? 0;
  const todayRatio = habit.habitType === 'unlimited' ? 1 - Math.exp(-todayCount / 3) : todayCount / Math.max(1, habit.dailyGoal);
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
          <Text style={styles.habitMeta}>{habit.habitType === 'unlimited' ? 'UNLIMITED · LOCAL' : 'DAILY · LOCAL'}</Text>
        </View>
        <Pressable accessibilityHint={habit.habitType === 'unlimited' ? 'Long press to undo one log' : undefined} accessibilityLabel={habit.habitType === 'unlimited' ? `Log ${habit.name}; ${todayCount} today` : `${todayComplete ? 'Uncheck' : 'Complete'} ${habit.name} today`} accessibilityRole="button" onLongPress={habit.habitType === 'unlimited' && todayCount > 0 ? () => { suppressPress.current = true; onDecrement(habit.id, today); } : undefined} onPress={() => { if (suppressPress.current) { suppressPress.current = false; return; } onToggle(habit.id, today); }} style={({ pressed }) => [styles.todayButton, { backgroundColor: progressColor(habit.color, todayCount, habit.dailyGoal, habit.habitType === 'unlimited'), borderColor: `${habit.color}70` }, pressed && styles.pressed]}>
          <Text style={[styles.todayCheck, { color: todayRatio >= 0.65 ? '#101012' : habit.color }, todayComplete && styles.todayCheckActive]}>{habit.habitType === 'unlimited' ? `${todayCount}/∞` : habit.dailyGoal > 1 ? `${todayCount}/${habit.dailyGoal}` : todayComplete ? '✓' : '+'}</Text>
        </Pressable>
      </View>

      <View style={[styles.statsStrip, { backgroundColor: `${habit.color}26` }]}>
        <Text style={styles.statText}>● {habit.currentStreak} DAY STREAK</Text>
        <Text style={styles.statText}>{total} DAYS  ·  {habit.habitType === 'unlimited' ? 'NO LIMIT' : `GOAL ${habit.dailyGoal}×`}</Text>
      </View>

      <View style={styles.historyRow}>
        <View style={styles.weekdayLabels}>{WEEKDAYS.map((day, index) => <Text key={`${day}-${index}`} style={styles.weekday}>{day}</Text>)}</View>
        <View style={styles.weeks}>
          {weeks.map((week, weekIndex) => (
            <View key={weekIndex} style={styles.weekColumn}>
              {week.map((day) => {
                const count = habit.completionCounts[day.key] ?? 0;
                const done = completed.has(day.key);
                return <Pressable key={day.key} accessibilityLabel={`Open ${habit.name} history at ${day.key}, ${count}${habit.habitType === 'unlimited' ? ' logs' : ` of ${habit.dailyGoal}`}`} disabled={day.future} onPress={() => onOpen(habit)} style={({ pressed }) => [styles.historyDot, { backgroundColor: progressColor(habit.color, count, habit.dailyGoal, habit.habitType === 'unlimited') }, day.future && styles.futureDot, pressed && styles.pressed]}>{habit.habitType === 'unlimited' && !day.future && <Text style={[styles.historyDotCount, { color: count >= 3 ? '#111114' : '#F4F4F2' }]}>{unlimitedDotLabel(count)}</Text>}</Pressable>;
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

function HabitDetail({ habit, month, onChangeMonth, onClose, onDecrement, onEdit, onGoal, onReminder, onToggle }: { habit: Habit; month: Date; onChangeMonth: (offset: number) => void; onClose: () => void; onDecrement: (habitId: number, date: string) => void; onEdit: () => void; onGoal: (goal: number) => void; onReminder: (hour: number, minute: number, enabled: boolean) => void; onToggle: (habitId: number, date: string) => void }) {
  const weeks = useMemo(() => historyWeeks(), []);
  const suppressPress = useRef(false);
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
            <View style={styles.settingLine}><View><Text style={styles.settingTitle}>{habit.habitType === 'unlimited' ? 'UNLIMITED LOGGING' : 'DAILY TARGET'}</Text><Text style={styles.settingHint}>{habit.habitType === 'unlimited' ? 'Every log brightens the day' : 'Incremental check-ins'}</Text></View>{habit.habitType === 'unlimited' ? <Text style={styles.stepValue}>∞</Text> : <View style={styles.stepper}><Pressable onPress={() => onGoal(habit.dailyGoal - 1)} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><Text style={styles.stepValue}>{habit.dailyGoal}×</Text><Pressable onPress={() => onGoal(habit.dailyGoal + 1)} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable></View>}</View>
            <View style={styles.settingDivider} />
            <View style={styles.settingLine}><Pressable onPress={() => onReminder(habit.reminderHour ?? 20, habit.reminderMinute ?? 0, !habit.reminderEnabled)}><Text style={styles.settingTitle}>REMINDER {habit.reminderEnabled ? 'ON' : 'OFF'}</Text><Text style={styles.settingHint}>Tap label to toggle</Text></Pressable><View style={styles.stepper}><Pressable onPress={() => shiftReminder(-15)} style={styles.stepButton}><Text style={styles.stepText}>‹</Text></Pressable><Text style={styles.reminderTime}>{reminderLabel}</Text><Pressable onPress={() => shiftReminder(15)} style={styles.stepButton}><Text style={styles.stepText}>›</Text></Pressable></View></View>
          </View>
          <View style={styles.overviewBox}>
            <View style={styles.historyRow}><View style={styles.weekdayLabels}>{WEEKDAYS.map((day, index) => <Text key={`${day}-${index}`} style={styles.weekday}>{day}</Text>)}</View><View style={styles.weeks}>{weeks.map((week, weekIndex) => <View key={weekIndex} style={styles.weekColumn}>{week.map((day) => { const count = habit.completionCounts[day.key] ?? 0; return <View key={day.key} style={[styles.historyDot, { backgroundColor: progressColor(habit.color, count, habit.dailyGoal, habit.habitType === 'unlimited') }, day.future && styles.futureDot]}>{habit.habitType === 'unlimited' && !day.future && <Text style={[styles.historyDotCount, { color: count >= 3 ? '#111114' : '#F4F4F2' }]}>{unlimitedDotLabel(count)}</Text>}</View>; })}</View>)}</View></View>
            <View style={styles.monthLabels}><Text style={styles.monthLabel}>MAR</Text><Text style={styles.monthLabel}>APR</Text><Text style={styles.monthLabel}>MAY</Text><Text style={styles.monthLabel}>JUN</Text><Text style={styles.monthLabel}>JUL</Text><Text style={styles.monthLabel}>AUG</Text></View>
          </View>

          <View style={styles.calendarBox}>
            <View style={styles.calendarWeek}>{WEEKDAYS.map((day, index) => <Text key={`${day}-${index}`} style={styles.calendarWeekday}>{day}</Text>)}</View>
            <View style={styles.calendarGrid}>{days.map((day) => {
              const count = habit.completionCounts[day.key] ?? 0;
              const bright = habit.habitType === 'unlimited' ? count >= 3 : count >= habit.dailyGoal;
              return <Pressable key={day.key} accessibilityHint={habit.habitType === 'unlimited' ? 'Long press to undo one log' : undefined} accessibilityLabel={`${habit.name}, ${day.key}, ${count}${habit.habitType === 'unlimited' ? ' logs' : ` of ${habit.dailyGoal}`}`} disabled={!day.inMonth || day.future} onLongPress={habit.habitType === 'unlimited' && count > 0 ? () => { suppressPress.current = true; onDecrement(habit.id, day.key); } : undefined} onPress={() => { if (suppressPress.current) { suppressPress.current = false; return; } onToggle(habit.id, day.key); }} style={({ pressed }) => [styles.calendarCell, !day.inMonth && styles.calendarOutside, count > 0 && { backgroundColor: progressColor(habit.color, count, habit.dailyGoal, habit.habitType === 'unlimited'), borderColor: habit.color }, pressed && styles.pressed]}><Text style={[styles.calendarDay, count > 0 && { color: bright ? '#111114' : '#F4F4F2' }]}>{day.day}</Text><Text style={[styles.calendarState, count > 0 && { color: bright ? '#111114' : '#F4F4F2' }]}>{count}/{habit.habitType === 'unlimited' ? '∞' : habit.dailyGoal}</Text></Pressable>;
            })}</View>
          </View>
          <View style={styles.monthControls}><Pressable accessibilityLabel="Previous month" onPress={() => onChangeMonth(-1)} style={styles.monthArrow}><Text style={styles.monthArrowText}>‹</Text></Pressable><View style={styles.monthName}><Text style={styles.monthNameText}>{month.toLocaleDateString(undefined, { month: 'long' }).toUpperCase()}</Text></View><View style={styles.yearBox}><Text style={styles.monthNameText}>{month.getFullYear()}</Text></View><Pressable accessibilityLabel="Next month" onPress={() => onChangeMonth(1)} style={styles.monthArrow}><Text style={styles.monthArrowText}>›</Text></Pressable></View>
        </ScrollView>
      </SafeAreaView>
    </View>
  </Modal>;
}

type EditableReminder = { key: string; hour: number; minute: number; enabled: boolean; label: string | null; body: string | null; snoozeMinutes: number; followupMinutes: number; followupCount: number };
const newReminder = (): EditableReminder => ({ key: `${Date.now()}`, hour: 9, minute: 0, enabled: true, label: null, body: null, ...REMINDER_DEFAULTS });
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

const clampReminderValue = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function ReminderStepper({ label, hint, value, min, max, step, suffix, onChange }: { label: string; hint: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
  return <View style={styles.optionRow}>
    <View style={styles.optionIdentity}><Text style={styles.optionLabel}>{label}</Text><Text style={styles.settingHint}>{hint}</Text></View>
    <View style={styles.stepper}>
      <Pressable accessibilityLabel={`Decrease ${label}`} onPress={() => onChange(clampReminderValue(value - step, min, max))} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable>
      <Text style={styles.stepValue}>{value === 0 ? 'OFF' : `${value}${suffix}`}</Text>
      <Pressable accessibilityLabel={`Increase ${label}`} onPress={() => onChange(clampReminderValue(value + step, min, max))} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable>
    </View>
  </View>;
}

function ReminderEditor({ color, index, onChange, onDelete, reminder }: { color: string; index: number; onChange: (changes: Partial<EditableReminder>) => void; onDelete: () => void; reminder: EditableReminder }) {
  const [expanded, setExpanded] = useState(false);
  const nagSummary = reminder.followupCount === 0 ? 'no follow-ups' : `${reminder.followupCount} follow-up${reminder.followupCount === 1 ? '' : 's'} every ${reminder.followupMinutes}m`;
  return <View style={styles.reminderBlock}>
    <View style={styles.reminderRow}>
      <Pressable accessibilityLabel={`Turn reminder ${index + 1} ${reminder.enabled ? 'off' : 'on'}`} onPress={() => onChange({ enabled: !reminder.enabled })} style={[styles.reminderToggle, reminder.enabled && { backgroundColor: color }]}><View style={[styles.toggleKnob, reminder.enabled && styles.toggleKnobOn]} /></Pressable>
      <View style={styles.reminderIdentity}><Text style={styles.reminderName}>{(reminder.label?.trim() || `REMINDER ${index + 1}`).toUpperCase()}</Text><Text style={[styles.reminderBigTime, !reminder.enabled && styles.muted]}>{formatTime(reminder.hour, reminder.minute)}</Text></View>
      <Pressable accessibilityLabel={`Set reminder ${index + 1} time`} onPress={() => openTimePicker(reminder.hour, reminder.minute, (hour, minute) => onChange({ hour, minute }))} style={styles.timePickerButton}><Text style={styles.timePickerIcon}>◷</Text><Text style={styles.timePickerLabel}>SET TIME</Text></Pressable>
      <Pressable accessibilityLabel={`Delete reminder ${index + 1}`} onPress={onDelete} style={styles.deleteReminder}><Text style={styles.deleteReminderText}>×</Text></Pressable>
    </View>
    <Pressable onPress={() => setExpanded((value) => !value)} style={styles.optionsToggle}>
      <Text style={styles.optionsSummary}>{nagSummary} · snooze {reminder.snoozeMinutes}m</Text>
      <Text style={styles.optionsChevron}>{expanded ? '˄' : '˅'}</Text>
    </Pressable>
    {expanded && <View style={styles.optionsPanel}>
      <Text style={styles.optionLabel}>NOTIFICATION TITLE</Text>
      <TextInput maxLength={120} onChangeText={(value) => onChange({ label: value })} placeholder="Habit name" placeholderTextColor="#5E5E66" style={styles.optionInput} value={reminder.label ?? ''} />
      <Text style={[styles.optionLabel, styles.optionLabelSpaced]}>MESSAGE</Text>
      <TextInput maxLength={120} onChangeText={(value) => onChange({ body: value })} placeholder="Due now." placeholderTextColor="#5E5E66" style={styles.optionInput} value={reminder.body ?? ''} />
      <ReminderStepper hint="Extra nudges if you have not logged it yet" label="FOLLOW-UPS" max={5} min={0} onChange={(value) => onChange({ followupCount: value })} step={1} suffix="×" value={reminder.followupCount} />
      <ReminderStepper hint="Gap between each follow-up" label="FOLLOW-UP GAP" max={120} min={5} onChange={(value) => onChange({ followupMinutes: value })} step={5} suffix="m" value={reminder.followupMinutes} />
      <ReminderStepper hint="How long the Snooze button waits" label="SNOOZE" max={120} min={5} onChange={(value) => onChange({ snoozeMinutes: value })} step={5} suffix="m" value={reminder.snoozeMinutes} />
    </View>}
  </View>;
}

function EditHabit({ habit, onClose, onSave }: { habit: Habit; onClose: () => void; onSave: (name: string, color: string, goal: number, habitType: HabitType, reminders: EditableReminder[]) => Promise<void> }) {
  const [draftName, setDraftName] = useState(habit.name);
  const [color, setColor] = useState(habit.color);
  const [goal, setGoal] = useState(habit.dailyGoal);
  const [habitType, setHabitType] = useState<HabitType>(habit.habitType);
  const [saving, setSaving] = useState(false);
  const [reminders, setReminders] = useState<EditableReminder[]>(() => habit.reminders.map((item) => ({ ...item, key: String(item.id) })));
  const updateReminder = (key: string, changes: Partial<EditableReminder>) => setReminders((items) => items.map((item) => item.key === key ? { ...item, ...changes } : item));
  const save = async () => { if (!draftName.trim() || saving) return; setSaving(true); try { await onSave(draftName.trim(), color, goal, habitType, reminders); } finally { setSaving(false); } };
  return <Modal animationType="slide" onRequestClose={onClose} visible>
    <SafeAreaView edges={['top', 'bottom']} style={styles.editScreen}>
      <View style={styles.editHeader}><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.editBack}>‹</Text></Pressable><Text style={styles.editTitle}>EDIT HABIT</Text><Pressable onPress={save} style={[styles.editDone, saving && styles.disabled]}><Text style={styles.editDoneText}>✓</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.editContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.editLabel}>HABIT NAME</Text>
        <TextInput onChangeText={setDraftName} placeholder="NAME YOUR HABIT" placeholderTextColor="#67676D" style={styles.editInput} value={draftName} />
        <Text style={styles.editLabel}>COLOR</Text>
        <View style={styles.colorGrid}>{COLORS.map((option) => <Pressable accessibilityLabel={`Use color ${option}`} key={option} onPress={() => setColor(option)} style={[styles.colorChoice, { backgroundColor: option }, color === option && styles.colorSelected]}>{color === option && <Text style={styles.colorCheck}>✓</Text>}</Pressable>)}</View>
        <Text style={styles.editLabel}>TRACKING TYPE</Text>
        <View style={styles.typePicker}><Pressable accessibilityLabel="Use a daily target" onPress={() => setHabitType('target')} style={[styles.typeChoice, habitType === 'target' && styles.typeChoiceActive]}><Text style={[styles.typeChoiceTitle, habitType === 'target' && styles.typeChoiceTextActive]}>DAILY TARGET</Text><Text style={styles.settingHint}>Finish at a set count</Text></Pressable><Pressable accessibilityLabel="Use unlimited logging" onPress={() => setHabitType('unlimited')} style={[styles.typeChoice, habitType === 'unlimited' && styles.typeChoiceActive]}><Text style={[styles.typeChoiceTitle, habitType === 'unlimited' && styles.typeChoiceTextActive]}>UNLIMITED ∞</Text><Text style={styles.settingHint}>Every log adds intensity</Text></Pressable></View>
        {habitType === 'target' && <><Text style={styles.editLabel}>HOW MANY TIMES PER DAY?</Text><View style={styles.goalEditor}><View><Text style={styles.goalNumber}>{goal}×</Text><Text style={styles.settingHint}>Each notification action increments progress</Text></View><View style={styles.stepper}><Pressable onPress={() => setGoal(Math.max(1, goal - 1))} style={styles.largeStep}><Text style={styles.stepText}>−</Text></Pressable><Pressable onPress={() => setGoal(Math.min(20, goal + 1))} style={styles.largeStep}><Text style={styles.stepText}>+</Text></Pressable></View></View></>}
        <View style={styles.reminderHeading}><View><Text style={styles.editLabelNoMargin}>REMINDERS</Text><Text style={styles.settingHint}>Choose every time you want to be notified</Text></View><Pressable accessibilityLabel="Add reminder" onPress={() => setReminders((items) => [...items, newReminder()])} style={styles.addReminder}><Text style={styles.addReminderText}>+</Text></Pressable></View>
        {reminders.length === 0 && <View style={styles.noReminders}><Text style={styles.noRemindersTitle}>NO REMINDERS</Text><Text style={styles.settingHint}>Tap + to add a notification time.</Text></View>}
        {reminders.map((reminder, index) => <ReminderEditor
          color={color}
          index={index}
          key={reminder.key}
          onChange={(changes) => updateReminder(reminder.key, changes)}
          onDelete={() => setReminders((items) => items.filter((item) => item.key !== reminder.key))}
          reminder={reminder}
        />)}
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
  const [activeScreen, setActiveScreen] = useState<'habits' | 'analytics' | 'logs' | 'backup'>('habits');
  const [backupBusy, setBackupBusy] = useState(false);
  const [viewedMonth, setViewedMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [health, setHealth] = useState<NotificationHealth | null>(null);
  const [missed, setMissed] = useState<Awaited<ReturnType<typeof getMissedToday>>>([]);
  const refresh = useCallback(async () => { setHabits(await getHabits()); setMissed(await getMissedToday()); }, []);

  /**
   * One reconcile pass: re-arm every alarm, refresh the health verdict, and post a
   * catch-up for anything already overdue. Runs on launch and on every return to the
   * foreground, which is what keeps a reminder self-healing after a reboot or an
   * Android-side cancellation.
   */
  const syncReminders = useCallback(async (requestPermission: boolean) => {
    const next = await configureNotifications(requestPermission);
    setHealth(next);
    await notifyMissedReminders();
    setMissed(await getMissedToday());
    return next;
  }, []);

  // Re-arming touches every reminder and its follow-ups, so doing it on each tap of a
  // 15-minute stepper drops taps while the previous pass is still running. Coalesce them,
  // and run them one at a time: two passes overlapping a habit save deadlock on SQLite.
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncQueue = useRef<Promise<unknown>>(Promise.resolve());
  const runSync = useCallback((requestPermission: boolean): Promise<NotificationHealth> => {
    if (syncTimer.current) { clearTimeout(syncTimer.current); syncTimer.current = null; }
    const next = syncQueue.current.catch(() => undefined).then(() => syncReminders(requestPermission));
    syncQueue.current = next;
    return next;
  }, [syncReminders]);
  useEffect(() => () => { if (syncTimer.current) clearTimeout(syncTimer.current); }, []);

  const showNotificationProblem = useCallback(async (health: NotificationHealth) => {
    if (health.ready) {
      await setSetting('notification_problem_seen', '');
      return;
    }
    if (await getSetting('notification_problem_seen') === health.issue) return;
    await setSetting('notification_problem_seen', health.issue ?? 'unknown');
    // Each issue gets the screen that resolves it; a generic "open settings" leaves the
    // user hunting for a toggle three levels down in Android's app info page.
    const remedy = health.issue === 'permission-denied'
      ? { message: 'Notifications are not allowed, so no reminder can reach you.', label: 'Allow notifications', fix: openNotificationSettings }
      : health.issue === 'channel-disabled'
        ? { message: 'The important reminders channel is turned off, so reminders are scheduled but never shown.', label: 'Open channel', fix: openNotificationSettings }
        : health.issue === 'exact-alarms-blocked'
          ? { message: 'Android will not let HabbitDot set exact alarms, so it is free to delay a reminder past the time you set or drop it entirely. Turn on "Alarms & reminders".', label: 'Fix now', fix: openExactAlarmSettings }
          : health.issue === 'alarms-missing' || health.issue === 'alarms-repaired'
            ? { message: health.issue === 'alarms-repaired' ? 'Android removed reminder alarms while HabbitDot was closed. They have been restored; unrestricted battery use can prevent this happening overnight.' : 'Expo remembers the reminders, but Android removed their alarms. Review battery settings and return to re-arm them.', label: 'Review battery', fix: openBatteryOptimizationSettings }
          : health.issue === 'battery-optimized'
            ? { message: 'Battery optimisation is on for HabbitDot. Allowing unrestricted battery use makes reminders more dependable on this phone.', label: 'Review battery', fix: openBatteryOptimizationSettings }
            : { message: 'Android did not accept every reminder. Open the logs to see which one failed.', label: 'Open settings', fix: openNotificationSettings };
    Alert.alert('Reminders need attention', remedy.message, [
      { text: 'Later', style: 'cancel' },
      { text: remedy.label, onPress: remedy.fix },
    ]);
  }, []);

  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => { syncTimer.current = null; runSync(false).then(showNotificationProblem).catch(console.error); }, 900);
  }, [runSync, showNotificationProblem]);

  useEffect(() => {
    let notificationSubscription: { remove: () => void } | undefined;
    initializeDatabase().then(async () => {
      await addDiagnosticLog('info', 'app.started', 'HabbitDot initialized and began its notification health check.', { appState: AppState.currentState });
      await refresh();
      const notificationHealth = await runSync(true);
      await showNotificationProblem(notificationHealth);
      if (notificationHealth.ready) {
        notificationSubscription = (await listenForNotificationActions(refresh, setSelectedHabitId)) ?? undefined;
        const openedHabitId = await getLastOpenedHabitId();
        if (openedHabitId) setSelectedHabitId(openedHabitId);
        if (await getSetting('notification_delivery_check') !== '2') {
          await scheduleDeliveryVerification();
          await setSetting('notification_delivery_check', '2');
        }
      }
    }).catch((error) => Alert.alert('Could not initialize HabbitDot', String(error))).finally(() => setLoading(false));
    return () => notificationSubscription?.remove();
  }, [refresh, runSync, showNotificationProblem]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') runSync(false).then(showNotificationProblem).catch(console.error);
    });
    return () => subscription.remove();
  }, [runSync, showNotificationProblem]);


  async function createHabit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await addHabit(trimmed, COLORS[habits.length % COLORS.length]);
    setName(''); setAdding(false); await refresh();
  }

  async function markDay(habitId: number, date: string) { await toggleEntry(habitId, date); await refresh(); if (date === dateKey(new Date())) { await dismissRemindersFor(habitId); scheduleSync(); } }
  async function undoDay(habitId: number, date: string) { await decrementEntry(habitId, date); await refresh(); if (date === dateKey(new Date())) scheduleSync(); }
  async function changeGoal(habitId: number, goal: number) { await updateDailyGoal(habitId, goal); await refresh(); scheduleSync(); }
  async function changeReminder(habitId: number, hour: number, minute: number, enabled: boolean) { await updatePrimaryReminder(habitId, hour, minute, enabled); await refresh(); scheduleSync(); }
  async function saveHabitEdits(habitId: number, nextName: string, color: string, goal: number, habitType: HabitType, reminders: EditableReminder[]) {
    await updateHabit(habitId, nextName, color, goal, habitType);
    await replaceHabitReminders(habitId, reminders.map(({ key, ...reminder }) => reminder));
    await refresh();
    setEditingHabitId(null);
    // After the modal closes, so a reconcile problem can never strand the editor.
    await runSync(false).then(showNotificationProblem);
  }

  async function exportBackup() {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is unavailable on this device.');
      const backup = await createBackup();
      const day = new Date().toISOString().slice(0, 10);
      const file = new File(Paths.cache, `habbitdot-backup-${day}.json`);
      file.write(JSON.stringify(backup, null, 2));
      await Sharing.shareAsync(file.uri, { dialogTitle: 'Save HabbitDot backup', mimeType: 'application/json' });
    } catch (error) {
      Alert.alert('Could not export backup', error instanceof Error ? error.message : String(error));
    } finally {
      setBackupBusy(false);
    }
  }

  async function importBackup() {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/json', 'text/plain'], copyToCacheDirectory: true, multiple: false });
      if (picked.canceled) return;
      if ((picked.assets[0].size ?? 0) > 10_000_000) throw new Error('Backup is larger than the 10 MB safety limit.');
      const backup = parseBackup(await new File(picked.assets[0].uri).text());
      const confirmed = await new Promise<boolean>((resolve) => Alert.alert(
        'Replace current data?',
        `This valid backup contains ${backup.habits.length} habits and ${backup.entries.length} check-ins. Your current HabbitDot data will be replaced.`,
        [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) }, { text: 'Restore backup', style: 'destructive', onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) },
      ));
      if (!confirmed) return;
      await restoreBackup(backup);
      setSelectedHabitId(null);
      setEditingHabitId(null);
      await refresh();
      await showNotificationProblem(await runSync(false));
      Alert.alert('Backup restored', `${backup.habits.length} habits and ${backup.entries.length} check-ins were restored.`);
    } catch (error) {
      Alert.alert('Could not import backup', error instanceof Error ? error.message : String(error));
    } finally {
      setBackupBusy(false);
    }
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

          {!loading && <View style={styles.banners}>
            <ReminderHealthBanner health={health} onOpenLogs={() => { setAdding(false); setActiveScreen('logs'); }} />
            <MissedTodayBanner missed={missed} onLog={(habitId) => markDay(habitId, dateKey(new Date()))} />
          </View>}

          {loading ? <ActivityIndicator color="#B7F171" style={styles.loader} /> : (
            <FlatList contentContainerStyle={styles.list} data={habits} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <HabitCard habit={item} onDecrement={undoDay} onOpen={(habit) => { setSelectedHabitId(habit.id); setViewedMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); }} onToggle={markDay} />} showsVerticalScrollIndicator={false}
              ListEmptyComponent={<View style={styles.empty}><View style={styles.emptyOrbit}><View style={styles.emptyCenter} /></View><Text style={styles.emptyTitle}>YOUR GRID IS READY</Text><Text style={styles.emptyBody}>Tap + to add a habit. Each day becomes a dot in your story.</Text></View>} />
          )}

          {selectedHabitId !== null && habits.find((habit) => habit.id === selectedHabitId) && <HabitDetail habit={habits.find((habit) => habit.id === selectedHabitId)!} month={viewedMonth} onChangeMonth={(offset) => setViewedMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1))} onClose={() => setSelectedHabitId(null)} onDecrement={undoDay} onEdit={() => { setEditingHabitId(selectedHabitId); setSelectedHabitId(null); }} onGoal={(goal) => changeGoal(selectedHabitId, goal)} onReminder={(hour, minute, enabled) => changeReminder(selectedHabitId, hour, minute, enabled)} onToggle={markDay} />}
          {editingHabitId !== null && habits.find((habit) => habit.id === editingHabitId) && <EditHabit habit={habits.find((habit) => habit.id === editingHabitId)!} onClose={() => setEditingHabitId(null)} onSave={(nextName, color, goal, habitType, reminders) => saveHabitEdits(editingHabitId, nextName, color, goal, habitType, reminders)} />}
          </> : activeScreen === 'analytics' ? (loading ? <ActivityIndicator color="#B7F171" style={styles.loader} /> : <AnalyticsScreen habits={habits} />) : activeScreen === 'logs' ? <NotificationLogsScreen health={health} onRecheck={() => runSync(false)} /> : (
            <ScrollView contentContainerStyle={styles.backupScreen}>
              <Text style={styles.backupEyebrow}>DATA OWNERSHIP</Text>
              <Text style={styles.backupTitle}>BACKUP & RESTORE</Text>
              <Text style={styles.backupBody}>Export a portable JSON file containing every habit, reminder, check-in, and app setting. Keep it somewhere safe.</Text>
              <Pressable accessibilityLabel="Export HabbitDot backup" disabled={backupBusy} onPress={exportBackup} style={({ pressed }) => [styles.backupPrimary, (pressed || backupBusy) && styles.pressed]}>
                {backupBusy ? <ActivityIndicator color="#101012" /> : <><Text style={styles.backupPrimaryTitle}>EXPORT BACKUP</Text><Text style={styles.backupPrimaryHint}>Save or share a .json file</Text></>}
              </Pressable>
              <View style={styles.backupDivider} />
              <Text style={styles.backupWarningTitle}>RESTORE FROM FILE</Text>
              <Text style={styles.backupWarning}>The file is fully validated first. Nothing changes until you confirm. Restore is transactional, so an error cannot leave a partial database.</Text>
              <Pressable accessibilityLabel="Import HabbitDot backup" disabled={backupBusy} onPress={importBackup} style={({ pressed }) => [styles.backupSecondary, (pressed || backupBusy) && styles.pressed]}><Text style={styles.backupSecondaryText}>CHOOSE BACKUP FILE</Text></Pressable>
            </ScrollView>
          )}
          <View style={styles.bottomNav}>
            <Pressable accessibilityLabel="Habits" onPress={() => setActiveScreen('habits')} style={styles.navItem}><Text style={[styles.navIcon, activeScreen === 'habits' && styles.navActive]}>▦</Text><Text style={[styles.navLabel, activeScreen === 'habits' && styles.navActive]}>HABITS</Text></Pressable>
            <Pressable accessibilityLabel="Analytics" onPress={() => { setAdding(false); setActiveScreen('analytics'); }} style={styles.navItem}><Text style={[styles.navIcon, activeScreen === 'analytics' && styles.navActive]}>◔</Text><Text style={[styles.navLabel, activeScreen === 'analytics' && styles.navActive]}>ANALYTICS</Text></Pressable>
            <Pressable accessibilityLabel="Notification logs" onPress={() => { setAdding(false); setActiveScreen('logs'); }} style={styles.navItem}><Text style={[styles.navIcon, activeScreen === 'logs' && styles.navActive]}>!</Text><Text style={[styles.navLabel, activeScreen === 'logs' && styles.navActive]}>LOGS</Text></Pressable>
            <Pressable accessibilityLabel="Backup and restore" onPress={() => { setAdding(false); setActiveScreen('backup'); }} style={styles.navItem}><Text style={[styles.navIcon, activeScreen === 'backup' && styles.navActive]}>⇅</Text><Text style={[styles.navLabel, activeScreen === 'backup' && styles.navActive]}>BACKUP</Text></Pressable>
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
  card: { backgroundColor: '#101012', borderColor: '#29292E', borderRadius: 10, borderWidth: 1, marginBottom: 8, padding: 9 }, cardHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 7 }, habitIcon: { alignItems: 'center', borderRadius: 8, height: 34, justifyContent: 'center', width: 38 }, iconDot: { borderRadius: 7, borderWidth: 2, height: 14, width: 14 }, habitIdentity: { flex: 1, marginLeft: 9 }, habitName: { color: '#F1F1EF', fontFamily: 'monospace', fontSize: 12, fontWeight: '900', letterSpacing: 0.9 }, habitMeta: { color: '#6E6E75', fontFamily: 'monospace', fontSize: 6, fontWeight: '800', letterSpacing: 1.1, marginTop: 2 }, todayButton: { alignItems: 'center', borderRadius: 8, borderWidth: 1, height: 34, justifyContent: 'center', width: 43 }, todayCheck: { fontFamily: 'monospace', fontSize: 14, fontWeight: '900' }, todayCheckActive: { fontSize: 15 }, statsStrip: { borderRadius: 4, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 7, paddingVertical: 4 }, statText: { color: '#E3E3E1', fontFamily: 'monospace', fontSize: 6, fontWeight: '900', letterSpacing: 0.3 }, historyRow: { flexDirection: 'row' }, weekdayLabels: { gap: 2, marginRight: 5 }, weekday: { color: '#707077', fontFamily: 'monospace', fontSize: 6, fontWeight: '800', height: 9, lineHeight: 9, textAlign: 'center', width: 8 }, weeks: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' }, weekColumn: { gap: 2 }, historyDot: { alignItems: 'center', borderRadius: 5, height: 9, justifyContent: 'center', width: 9 }, historyDotCount: { fontFamily: 'monospace', fontSize: 5, fontWeight: '900', lineHeight: 7, textAlign: 'center' }, futureDot: { backgroundColor: '#1D1D21', opacity: 0.65 }, monthLabels: { flexDirection: 'row', justifyContent: 'space-around', marginLeft: 13, marginTop: 5 }, monthLabel: { color: '#5F5F66', fontFamily: 'monospace', fontSize: 5, fontWeight: '800', letterSpacing: 0.7 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 48, paddingTop: 120 }, emptyOrbit: { alignItems: 'center', borderColor: '#B7F171', borderRadius: 36, borderWidth: 2, height: 72, justifyContent: 'center', width: 72 }, emptyCenter: { backgroundColor: '#B7F171', borderRadius: 8, height: 16, width: 16 }, emptyTitle: { color: '#F4F4F2', fontSize: 18, fontWeight: '900', letterSpacing: 1, marginTop: 22 }, emptyBody: { color: '#85858C', fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  bottomNav: { backgroundColor: '#111114', borderTopColor: '#242428', borderTopWidth: 1, bottom: 0, flexDirection: 'row', left: 0, paddingBottom: 8, paddingTop: 8, position: 'absolute', right: 0 }, navItem: { alignItems: 'center', flex: 1 }, navIcon: { color: '#68686F', fontSize: 13, height: 17 }, navLabel: { color: '#68686F', fontFamily: 'monospace', fontSize: 5, fontWeight: '900', letterSpacing: 0.7, marginTop: 2 }, navActive: { color: '#B7F171' },
  backupScreen: { flexGrow: 1, paddingBottom: 110, paddingHorizontal: 20, paddingTop: 34 }, backupEyebrow: { color: '#B7F171', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', letterSpacing: 1.5 }, backupTitle: { color: '#F4F4F2', fontSize: 25, fontWeight: '900', letterSpacing: 1, marginTop: 7 }, backupBody: { color: '#929299', fontSize: 13, lineHeight: 20, marginTop: 12 }, backupPrimary: { backgroundColor: '#B7F171', borderRadius: 13, marginTop: 28, minHeight: 76, paddingHorizontal: 18, paddingVertical: 16 }, backupPrimaryTitle: { color: '#101012', fontSize: 13, fontWeight: '900', letterSpacing: 1 }, backupPrimaryHint: { color: '#344124', fontSize: 9, fontWeight: '700', marginTop: 5 }, backupDivider: { backgroundColor: '#2B2B30', height: 1, marginVertical: 30 }, backupWarningTitle: { color: '#F4F4F2', fontSize: 12, fontWeight: '900', letterSpacing: 1 }, backupWarning: { color: '#85858C', fontSize: 11, lineHeight: 18, marginTop: 9 }, backupSecondary: { alignItems: 'center', borderColor: '#55555C', borderRadius: 12, borderWidth: 1, marginTop: 20, paddingVertical: 17 }, backupSecondaryText: { color: '#F4F4F2', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.72)', flex: 1, justifyContent: 'flex-end' }, detailSheet: { backgroundColor: '#0B0B0D', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '90%' }, detailContent: { padding: 14, paddingBottom: 22 },
  detailHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 10 }, detailIcon: { alignItems: 'center', borderRadius: 10, height: 44, justifyContent: 'center', width: 48 }, detailName: { color: '#F4F4F2', fontSize: 17, fontWeight: '900', letterSpacing: 0.8 }, editButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 10, height: 40, justifyContent: 'center', marginRight: 6, width: 44 }, editButtonText: { color: '#F4F4F2', fontSize: 21 }, closeButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 10, height: 40, justifyContent: 'center', width: 44 }, closeText: { color: '#F4F4F2', fontSize: 25, lineHeight: 27 },
  overviewBox: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, marginBottom: 12, padding: 9 }, calendarBox: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, padding: 8 }, calendarWeek: { flexDirection: 'row', marginBottom: 6 }, calendarWeekday: { color: '#77777E', flex: 1, fontSize: 8, fontWeight: '900', textAlign: 'center' }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarCell: { alignItems: 'center', borderColor: '#29292E', borderRadius: 7, borderWidth: 1, height: 47, justifyContent: 'center', margin: '0.5%', width: '13.28%' }, calendarOutside: { borderColor: 'transparent', opacity: 0.16 }, calendarDay: { color: '#E6E6E4', fontSize: 12, fontWeight: '900' }, calendarState: { color: '#626269', fontSize: 5, fontWeight: '900', letterSpacing: 0.3, marginTop: 2 },
  monthControls: { flexDirection: 'row', gap: 7, marginTop: 11 }, monthArrow: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 9, height: 42, justifyContent: 'center', width: 46 }, monthArrowText: { color: '#F4F4F2', fontSize: 25 }, monthName: { alignItems: 'center', borderColor: '#303036', borderRadius: 9, borderWidth: 1, flex: 1, justifyContent: 'center' }, yearBox: { alignItems: 'center', borderColor: '#303036', borderRadius: 9, borderWidth: 1, justifyContent: 'center', width: 65 }, monthNameText: { color: '#F4F4F2', fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  reminderSettings: { borderColor: '#303036', borderRadius: 10, borderWidth: 1, marginBottom: 12, paddingHorizontal: 10 }, settingLine: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 54 }, settingTitle: { color: '#F4F4F2', fontSize: 9, fontWeight: '900', letterSpacing: 0.7 }, settingHint: { color: '#6F6F76', fontSize: 7, marginTop: 3 }, settingDivider: { backgroundColor: '#29292E', height: 1 }, stepper: { alignItems: 'center', flexDirection: 'row', gap: 7 }, stepButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 7, height: 30, justifyContent: 'center', width: 30 }, stepText: { color: '#F4F4F2', fontSize: 17, fontWeight: '700' }, stepValue: { color: '#B7F171', fontSize: 12, fontWeight: '900', minWidth: 28, textAlign: 'center' }, reminderTime: { color: '#B7F171', fontSize: 9, fontWeight: '900', minWidth: 62, textAlign: 'center' },
  banners: { paddingHorizontal: 14 },
  reminderBlock: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, marginBottom: 8 },
  optionsToggle: { alignItems: 'center', borderTopColor: '#252529', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 9 },
  optionsSummary: { color: '#7E7E85', fontSize: 8, fontWeight: '700', letterSpacing: 0.4 },
  optionsChevron: { color: '#7E7E85', fontSize: 12, fontWeight: '900' },
  optionsPanel: { borderTopColor: '#252529', borderTopWidth: 1, paddingBottom: 6, paddingHorizontal: 12, paddingTop: 12 },
  optionLabel: { color: '#DADAD8', fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  optionLabelSpaced: { marginTop: 14 },
  optionInput: { borderColor: '#303036', borderRadius: 9, borderWidth: 1, color: '#F4F4F2', fontSize: 12, fontWeight: '700', marginTop: 7, paddingHorizontal: 11, paddingVertical: 10 },
  optionRow: { alignItems: 'center', borderTopColor: '#212125', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingVertical: 10 },
  optionIdentity: { flex: 1, paddingRight: 10 },
  editScreen: { backgroundColor: '#0B0B0D', flex: 1 }, editHeader: { alignItems: 'center', borderBottomColor: '#252529', borderBottomWidth: 1, flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12 }, editBack: { color: '#F4F4F2', fontSize: 29, lineHeight: 31 }, editTitle: { color: '#F4F4F2', flex: 1, fontSize: 20, fontWeight: '900', letterSpacing: 1.2 }, editDone: { alignItems: 'center', backgroundColor: '#F4F4F2', borderRadius: 10, height: 40, justifyContent: 'center', width: 44 }, editDoneText: { color: '#101012', fontSize: 20, fontWeight: '900' }, editContent: { padding: 18, paddingBottom: 42 }, editLabel: { color: '#DADAD8', fontSize: 10, fontWeight: '900', letterSpacing: 1, marginBottom: 10, marginTop: 20 }, editLabelNoMargin: { color: '#DADAD8', fontSize: 10, fontWeight: '900', letterSpacing: 1 }, editInput: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, color: '#F4F4F2', fontSize: 15, fontWeight: '800', letterSpacing: 0.5, paddingHorizontal: 14, paddingVertical: 14 }, colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, colorChoice: { alignItems: 'center', borderRadius: 10, height: 48, justifyContent: 'center', width: '22.9%' }, colorSelected: { borderColor: '#FFFFFF', borderWidth: 3 }, colorCheck: { color: '#FFFFFF', fontSize: 18, fontWeight: '900' }, goalEditor: { alignItems: 'center', borderColor: '#303036', borderRadius: 11, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', padding: 14 }, goalNumber: { color: '#F4F4F2', fontSize: 22, fontWeight: '900' }, largeStep: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 9, height: 42, justifyContent: 'center', width: 46 }, reminderHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, marginTop: 24 }, addReminder: { alignItems: 'center', backgroundColor: '#F4F4F2', borderRadius: 9, height: 38, justifyContent: 'center', width: 42 }, addReminderText: { color: '#101012', fontSize: 24 }, noReminders: { borderColor: '#303036', borderRadius: 11, borderStyle: 'dashed', borderWidth: 1, padding: 18 }, noRemindersTitle: { color: '#85858C', fontSize: 10, fontWeight: '900' }, reminderRow: { alignItems: 'center', flexDirection: 'row', gap: 7, padding: 10 }, reminderToggle: { backgroundColor: '#34343A', borderRadius: 11, height: 22, padding: 3, width: 38 }, toggleKnob: { backgroundColor: '#F4F4F2', borderRadius: 8, height: 16, width: 16 }, toggleKnobOn: { alignSelf: 'flex-end' }, reminderIdentity: { flex: 1 }, reminderName: { color: '#73737A', fontSize: 6, fontWeight: '900', letterSpacing: 0.8 }, reminderBigTime: { color: '#F4F4F2', fontSize: 13, fontWeight: '900', marginTop: 2 }, timePickerButton: { alignItems: 'center', backgroundColor: '#202024', borderRadius: 8, flexDirection: 'row', gap: 5, height: 34, justifyContent: 'center', paddingHorizontal: 9 }, timePickerIcon: { color: '#F4F4F2', fontSize: 17 }, timePickerLabel: { color: '#F4F4F2', fontSize: 7, fontWeight: '900', letterSpacing: 0.5 }, muted: { color: '#67676D' }, deleteReminder: { alignItems: 'center', height: 30, justifyContent: 'center', width: 25 }, deleteReminderText: { color: '#FF7780', fontSize: 22 }, saveHabitButton: { alignItems: 'center', backgroundColor: '#F4F4F2', borderRadius: 12, marginTop: 24, paddingVertical: 17 }, saveHabitText: { color: '#101012', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  typePicker: { flexDirection: 'row', gap: 8 }, typeChoice: { borderColor: '#303036', borderRadius: 11, borderWidth: 1, flex: 1, padding: 13 }, typeChoiceActive: { backgroundColor: '#B7F17118', borderColor: '#B7F171' }, typeChoiceTitle: { color: '#B0B0B5', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 }, typeChoiceTextActive: { color: '#B7F171' },
});
