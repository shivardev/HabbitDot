import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Habit } from './database';

type RangeDays = 7 | 30 | 90 | 365;
type DayMetric = { date: Date; key: string; completed: number; possible: number; rate: number };

const RANGES: Array<{ label: string; days: RangeDays }> = [
  { label: '7D', days: 7 }, { label: '30D', days: 30 }, { label: '90D', days: 90 }, { label: '1Y', days: 365 },
];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }

function buildDays(habits: Habit[], rangeDays: RangeDays): DayMetric[] {
  const today = startOfDay(new Date());
  return Array.from({ length: rangeDays }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (rangeDays - 1 - index));
    const key = dateKey(date);
    let completed = 0;
    let possible = 0;
    for (const habit of habits) {
      if (startOfDay(new Date(habit.createdAt)) > date) continue;
      possible += habit.dailyGoal;
      completed += Math.min(habit.completionCounts[key] ?? 0, habit.dailyGoal);
    }
    return { date, key, completed, possible, rate: possible ? completed / possible : 0 };
  });
}

function bestPerfectStreak(days: DayMetric[]) {
  let best = 0;
  let current = 0;
  for (const day of days) {
    current = day.possible > 0 && day.completed >= day.possible ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

function AnalyticsBar({ value, color = '#B7F171', width = '100%' }: { value: number; color?: string; width?: `${number}%` | number }) {
  return <View style={[styles.barTrack, { width }]}><View style={[styles.barFill, { backgroundColor: color, width: `${Math.max(2, Math.min(100, value * 100))}%` }]} /></View>;
}

export function AnalyticsScreen({ habits }: { habits: Habit[] }) {
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const analytics = useMemo(() => {
    const days = buildDays(habits, rangeDays);
    const completed = days.reduce((sum, day) => sum + day.completed, 0);
    const possible = days.reduce((sum, day) => sum + day.possible, 0);
    const rate = possible ? completed / possible : 0;
    const perfectDays = days.filter((day) => day.possible > 0 && day.completed >= day.possible).length;
    const weekday = WEEKDAYS.map((label, weekdayIndex) => {
      const matches = days.filter((day) => day.date.getDay() === weekdayIndex);
      const done = matches.reduce((sum, day) => sum + day.completed, 0);
      const target = matches.reduce((sum, day) => sum + day.possible, 0);
      return { label, rate: target ? done / target : 0 };
    });
    const bucketSize = rangeDays <= 30 ? 5 : rangeDays <= 90 ? 10 : 30;
    const trend = Array.from({ length: Math.ceil(days.length / bucketSize) }, (_, index) => {
      const bucket = days.slice(index * bucketSize, (index + 1) * bucketSize);
      const done = bucket.reduce((sum, day) => sum + day.completed, 0);
      const target = bucket.reduce((sum, day) => sum + day.possible, 0);
      return target ? done / target : 0;
    });
    const habitStats = habits.map((habit) => {
      const created = startOfDay(new Date(habit.createdAt));
      const eligible = days.filter((day) => day.date >= created);
      const target = eligible.length * habit.dailyGoal;
      const done = eligible.reduce((sum, day) => sum + Math.min(habit.completionCounts[day.key] ?? 0, habit.dailyGoal), 0);
      return { habit, done, target, rate: target ? done / target : 0 };
    }).sort((a, b) => b.rate - a.rate);
    return { days, completed, rate, perfectDays, bestStreak: bestPerfectStreak(days), weekday, trend, habitStats };
  }, [habits, rangeDays]);

  const rangeLabel = rangeDays === 365 ? 'LAST YEAR' : `LAST ${rangeDays} DAYS`;
  return <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.headerRow}>
      <View><Text style={styles.eyebrow}>PERFORMANCE</Text><Text style={styles.title}>ANALYTICS</Text></View>
      <View style={styles.liveBadge}><View style={styles.liveDot} /><Text style={styles.liveText}>LOCAL DATA</Text></View>
    </View>
    <View style={styles.rangeRow}>{RANGES.map((range) => <Pressable key={range.days} onPress={() => setRangeDays(range.days)} style={[styles.rangeButton, rangeDays === range.days && styles.rangeButtonActive]}><Text style={[styles.rangeText, rangeDays === range.days && styles.rangeTextActive]}>{range.label}</Text></Pressable>)}</View>

    <View style={styles.heroCard}>
      <View style={styles.heroTop}><View><Text style={styles.cardLabel}>COMPLETION RATE</Text><Text style={styles.heroValue}>{Math.round(analytics.rate * 100)}<Text style={styles.heroUnit}>%</Text></Text></View><Text style={styles.rangeCaption}>{rangeLabel}</Text></View>
      <AnalyticsBar value={analytics.rate} />
      <Text style={styles.heroCaption}>{analytics.completed} TARGET CHECK-INS COMPLETED</Text>
    </View>

    <View style={styles.metricGrid}>
      <View style={styles.metricCard}><Text style={styles.cardLabel}>CHECK-INS</Text><Text style={styles.metricValue}>{analytics.completed}</Text><Text style={styles.metricHint}>DOSES & ACTIONS</Text></View>
      <View style={styles.metricCard}><Text style={styles.cardLabel}>PERFECT DAYS</Text><Text style={styles.metricValue}>{analytics.perfectDays}</Text><Text style={styles.metricHint}>ALL TARGETS MET</Text></View>
      <View style={styles.metricCard}><Text style={styles.cardLabel}>BEST RUN</Text><Text style={styles.metricValue}>{analytics.bestStreak}<Text style={styles.metricUnit}>D</Text></Text><Text style={styles.metricHint}>PERFECT-DAY STREAK</Text></View>
      <View style={styles.metricCard}><Text style={styles.cardLabel}>ACTIVE HABITS</Text><Text style={styles.metricValue}>{habits.length}</Text><Text style={styles.metricHint}>TRACKED LOCALLY</Text></View>
    </View>

    <View style={styles.chartCard}>
      <View style={styles.sectionHeader}><View><Text style={styles.cardLabel}>MOMENTUM</Text><Text style={styles.sectionTitle}>COMPLETION TREND</Text></View><Text style={styles.sectionMeta}>{Math.round(analytics.rate * 100)}% AVG</Text></View>
      <View style={styles.trendChart}>{analytics.trend.map((value, index) => <View key={index} style={styles.trendColumn}><View style={[styles.trendBar, { height: `${Math.max(5, value * 100)}%`, backgroundColor: value >= .8 ? '#B7F171' : value >= .5 ? '#87C95B' : '#40532F' }]} /></View>)}</View>
      <View style={styles.axisRow}><Text style={styles.axisText}>OLDER</Text><Text style={styles.axisText}>TODAY</Text></View>
    </View>

    <View style={styles.chartCard}>
      <View style={styles.sectionHeader}><View><Text style={styles.cardLabel}>RHYTHM</Text><Text style={styles.sectionTitle}>BY DAY OF WEEK</Text></View></View>
      {analytics.weekday.map((day) => <View key={day.label} style={styles.weekdayRow}><Text style={styles.weekdayLabel}>{day.label}</Text><AnalyticsBar value={day.rate} width="72%" /><Text style={styles.weekdayValue}>{Math.round(day.rate * 100)}%</Text></View>)}
    </View>

    <View style={styles.chartCard}>
      <View style={styles.sectionHeader}><View><Text style={styles.cardLabel}>BREAKDOWN</Text><Text style={styles.sectionTitle}>HABIT PERFORMANCE</Text></View></View>
      {analytics.habitStats.map(({ habit, done, target, rate }) => <View key={habit.id} style={styles.habitRow}>
        <View style={[styles.habitMark, { backgroundColor: `${habit.color}28` }]}><View style={[styles.habitMarkInner, { borderColor: habit.color }]} /></View>
        <View style={styles.habitStats}><View style={styles.habitTitleRow}><Text numberOfLines={1} style={styles.habitName}>{habit.name.toUpperCase()}</Text><Text style={[styles.habitRate, { color: habit.color }]}>{Math.round(rate * 100)}%</Text></View><AnalyticsBar value={rate} color={habit.color} /><Text style={styles.habitMeta}>{done} OF {target} TARGET CHECK-INS</Text></View>
      </View>)}
      {habits.length === 0 && <Text style={styles.emptyText}>ADD A HABIT TO START BUILDING INSIGHTS.</Text>}
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingBottom: 110, paddingHorizontal: 14, paddingTop: 12 },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 }, eyebrow: { color: '#6D6D74', fontFamily: 'monospace', fontSize: 7, fontWeight: '900', letterSpacing: 1.5 }, title: { color: '#F4F4F2', fontFamily: 'monospace', fontSize: 23, fontWeight: '900', letterSpacing: 2, marginTop: 2 }, liveBadge: { alignItems: 'center', backgroundColor: '#171719', borderColor: '#2A2A2E', borderRadius: 9, borderWidth: 1, flexDirection: 'row', gap: 6, paddingHorizontal: 9, paddingVertical: 7 }, liveDot: { backgroundColor: '#B7F171', borderRadius: 4, height: 7, width: 7 }, liveText: { color: '#A3A3A8', fontFamily: 'monospace', fontSize: 6, fontWeight: '900', letterSpacing: .7 },
  rangeRow: { backgroundColor: '#111113', borderColor: '#28282C', borderRadius: 11, borderWidth: 1, flexDirection: 'row', gap: 5, marginBottom: 10, padding: 4 }, rangeButton: { alignItems: 'center', borderRadius: 8, flex: 1, paddingVertical: 9 }, rangeButtonActive: { backgroundColor: '#F1F1EF' }, rangeText: { color: '#74747B', fontFamily: 'monospace', fontSize: 8, fontWeight: '900' }, rangeTextActive: { color: '#111113' },
  heroCard: { backgroundColor: '#111113', borderColor: '#303034', borderRadius: 13, borderWidth: 1, marginBottom: 9, padding: 15 }, heroTop: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between' }, cardLabel: { color: '#73737A', fontFamily: 'monospace', fontSize: 7, fontWeight: '900', letterSpacing: 1 }, heroValue: { color: '#F4F4F2', fontFamily: 'monospace', fontSize: 30, fontWeight: '900', letterSpacing: -1, lineHeight: 36, marginBottom: 9, marginTop: 5 }, heroUnit: { color: '#B7F171', fontSize: 14 }, rangeCaption: { color: '#717178', fontFamily: 'monospace', fontSize: 7, fontWeight: '900', marginTop: 2 }, heroCaption: { color: '#77777E', fontFamily: 'monospace', fontSize: 6, fontWeight: '800', letterSpacing: .6, marginTop: 8 }, barTrack: { backgroundColor: '#29292D', borderRadius: 4, height: 7, overflow: 'hidden' }, barFill: { borderRadius: 4, height: '100%' },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 9 }, metricCard: { backgroundColor: '#111113', borderColor: '#2C2C30', borderRadius: 11, borderWidth: 1, padding: 12, width: '48.8%' }, metricValue: { color: '#F4F4F2', fontFamily: 'monospace', fontSize: 25, fontWeight: '900', marginTop: 5 }, metricUnit: { color: '#B7F171', fontSize: 11 }, metricHint: { color: '#5F5F66', fontFamily: 'monospace', fontSize: 5, fontWeight: '900', letterSpacing: .6, marginTop: 3 },
  chartCard: { backgroundColor: '#111113', borderColor: '#2C2C30', borderRadius: 12, borderWidth: 1, marginBottom: 9, padding: 13 }, sectionHeader: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 13 }, sectionTitle: { color: '#E9E9E7', fontFamily: 'monospace', fontSize: 11, fontWeight: '900', letterSpacing: .7, marginTop: 3 }, sectionMeta: { color: '#B7F171', fontFamily: 'monospace', fontSize: 7, fontWeight: '900' }, trendChart: { alignItems: 'flex-end', flexDirection: 'row', gap: 5, height: 112 }, trendColumn: { backgroundColor: '#1D1D20', borderRadius: 5, flex: 1, height: '100%', justifyContent: 'flex-end', overflow: 'hidden' }, trendBar: { borderRadius: 5, width: '100%' }, axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 }, axisText: { color: '#55555C', fontFamily: 'monospace', fontSize: 5, fontWeight: '900' },
  weekdayRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginBottom: 10 }, weekdayLabel: { color: '#8A8A91', fontFamily: 'monospace', fontSize: 7, fontWeight: '900', width: 28 }, weekdayValue: { color: '#DADAD8', fontFamily: 'monospace', fontSize: 7, fontWeight: '900', textAlign: 'right', width: 31 },
  habitRow: { alignItems: 'center', borderTopColor: '#26262A', borderTopWidth: 1, flexDirection: 'row', gap: 10, paddingVertical: 11 }, habitMark: { alignItems: 'center', borderRadius: 8, height: 36, justifyContent: 'center', width: 40 }, habitMarkInner: { borderRadius: 6, borderWidth: 2, height: 14, width: 14 }, habitStats: { flex: 1 }, habitTitleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }, habitName: { color: '#E9E9E7', flex: 1, fontFamily: 'monospace', fontSize: 9, fontWeight: '900', letterSpacing: .5 }, habitRate: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900' }, habitMeta: { color: '#595960', fontFamily: 'monospace', fontSize: 5, fontWeight: '900', letterSpacing: .4, marginTop: 5 }, emptyText: { color: '#68686F', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', paddingVertical: 24, textAlign: 'center' },
});
