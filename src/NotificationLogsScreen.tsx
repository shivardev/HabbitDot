import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { addDiagnosticLog, clearDiagnosticLogs, DiagnosticLog, getDiagnosticLogs, getRecentDeliveries, ReminderDelivery } from './database';
import { getNotificationDiagnostics, NotificationHealth, scheduleDeliveryVerification } from './notifications';
import {
  openBatteryOptimizationSettings,
  openExactAlarmSettings,
  openNotificationSettings,
} from '../modules/habbitdot-reliability';

const yesNo = (value: boolean | null) => value === null ? 'UNKNOWN' : value ? 'YES' : 'NO';
const timeOf = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const DELIVERY_STATE_COPY: Record<ReminderDelivery['state'], { label: string; style: object }> = {
  scheduled: { label: 'WAITING', style: { color: '#8A8A91' } },
  delivered: { label: 'DELIVERED', style: { color: '#B7F171' } },
  acted: { label: 'ACTED ON', style: { color: '#7CE7D5' } },
  unconfirmed: { label: 'UNCONFIRMED', style: { color: '#FFB86B' } },
};

/**
 * The three facts that decide whether a reminder arrives on time. Exact alarms is the one
 * that used to be invisible: everything else could read healthy while Android quietly
 * downgraded the alarm behind every reminder.
 */
function ReliabilityPanel({ health }: { health: NotificationHealth | null }) {
  if (!health) return null;
  const rows: Array<{ label: string; value: string; bad: boolean; fix?: () => void }> = [
    { label: 'NOTIFICATIONS ALLOWED', value: yesNo(!health.issues.includes('permission-denied')), bad: health.issues.includes('permission-denied'), fix: openNotificationSettings },
    { label: 'EXACT ALARMS ALLOWED', value: yesNo(health.exactAlarms), bad: health.exactAlarms === false, fix: openExactAlarmSettings },
    { label: 'BATTERY UNRESTRICTED', value: yesNo(health.batteryOptimized === null ? null : !health.batteryOptimized), bad: health.batteryOptimized === true, fix: openBatteryOptimizationSettings },
    { label: 'EXPO REMINDERS STORED', value: `${health.scheduled} OF ${health.expected}`, bad: health.scheduled !== health.expected },
    { label: 'ANDROID ALARMS LIVE', value: health.liveAlarms === null ? 'UNKNOWN' : `${health.liveAlarms} OF ${health.expected}`, bad: health.liveAlarms !== null && health.liveAlarms !== health.expected, fix: openBatteryOptimizationSettings },
  ];
  return <View style={styles.panel}>
    <Text style={styles.panelTitle}>DELIVERY READINESS</Text>
    {rows.map((row) => <View key={row.label} style={styles.panelRow}>
      <Text style={styles.panelLabel}>{row.label}</Text>
      <View style={styles.panelValueGroup}>
        <Text style={[styles.panelValue, row.bad && styles.panelValueBad]}>{row.value}</Text>
        {row.bad && row.fix && <Pressable onPress={row.fix} style={styles.panelFix}><Text style={styles.panelFixText}>FIX</Text></Pressable>}
      </View>
    </View>)}
    {health.device && <Text style={styles.panelFootnote}>{health.device.manufacturer} {health.device.model} · Android SDK {health.device.sdkInt}{health.device.isPowerSaveMode ? ' · POWER SAVER ON' : ''}</Text>}
  </View>;
}

function DeliveryTimeline({ deliveries }: { deliveries: ReminderDelivery[] }) {
  if (deliveries.length === 0) return null;
  return <View style={styles.panel}>
    <Text style={styles.panelTitle}>REMINDER TIMELINE</Text>
    <Text style={styles.panelNote}>Every occurrence the app asked Android for. UNCONFIRMED means the app was not running to witness it, not that it definitely failed.</Text>
    {deliveries.map((item) => {
      const state = DELIVERY_STATE_COPY[item.state];
      return <View key={item.id} style={styles.panelRow}>
        <View style={styles.timelineIdentity}>
          <Text style={styles.timelineName}>{item.habitName}<Text style={styles.timelineKind}> · {item.kind}</Text></Text>
          <Text style={styles.timelineTime}>{timeOf(item.occurrenceAt)}{item.actedAt ? ` · ${item.action}` : ''}</Text>
        </View>
        <Text style={[styles.panelValue, state.style]}>{state.label}</Text>
      </View>;
    })}
  </View>;
}

export function NotificationLogsScreen({ health, onRecheck }: { health: NotificationHealth | null; onRecheck: () => Promise<unknown> }) {
  const [logs, setLogs] = useState<DiagnosticLog[]>([]);
  const [deliveries, setDeliveries] = useState<ReminderDelivery[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => { setLogs(await getDiagnosticLogs()); setDeliveries(await getRecentDeliveries()); }, []);
  useEffect(() => { refresh().catch(console.error); }, [refresh]);
  const inspect = async () => {
    setRefreshing(true);
    // Re-arm as well as inspect, so the panel above reflects a permission the user just
    // granted in Settings rather than the state from before they left the app.
    try { await onRecheck(); await getNotificationDiagnostics(); await refresh(); } finally { setRefreshing(false); }
  };
  const test = async () => {
    try { await scheduleDeliveryVerification(); await addDiagnosticLog('info', 'test.scheduled', 'A test notification was scheduled for 10 seconds from now.'); }
    catch (error) { await addDiagnosticLog('error', 'test.failed', 'Could not schedule the test notification.', String(error)); }
    await refresh();
  };
  const clear = () => Alert.alert('Clear diagnostic logs?', 'This removes only diagnostic logs, not habits or reminders.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Clear', style: 'destructive', onPress: async () => { await clearDiagnosticLogs(); await refresh(); } }]);
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={inspect} tintColor="#B7F171" />}>
    <Text style={styles.eyebrow}>NOTIFICATION DIAGNOSTICS</Text><Text style={styles.title}>DELIVERY LOG</Text>
    <Text style={styles.body}>Newest first. Pull to refresh and record current permission, channel, and scheduled reminder state.</Text>
    <View style={styles.actions}><Pressable onPress={inspect} style={styles.primary}><Text style={styles.primaryText}>CHECK NOW</Text></Pressable><Pressable onPress={test} style={styles.secondary}><Text style={styles.secondaryText}>TEST IN 10 SEC</Text></Pressable></View>
    <ReliabilityPanel health={health} />
    <DeliveryTimeline deliveries={deliveries} />
    <Pressable onPress={clear}><Text style={styles.clear}>CLEAR LOGS</Text></Pressable>
    {logs.length === 0 ? <Text style={styles.empty}>No diagnostic events yet.</Text> : logs.map((item) => <View key={item.id} style={[styles.card, item.level === 'error' && styles.errorCard, item.level === 'warning' && styles.warningCard]}>
      <View style={styles.cardTop}><Text style={styles.step}>{item.step.toUpperCase()}</Text><Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text></View>
      <Text style={styles.message}>{item.message}</Text>{item.details && <Text selectable style={styles.details}>{item.details}</Text>}
    </View>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingBottom: 110, paddingHorizontal: 14, paddingTop: 20 }, eyebrow: { color: '#B7F171', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 }, title: { color: '#F4F4F2', fontSize: 25, fontWeight: '900', letterSpacing: 1, marginTop: 6 }, body: { color: '#898990', fontSize: 11, lineHeight: 17, marginTop: 8 }, actions: { flexDirection: 'row', gap: 8, marginTop: 18 }, primary: { alignItems: 'center', backgroundColor: '#B7F171', borderRadius: 10, flex: 1, paddingVertical: 13 }, primaryText: { color: '#101012', fontSize: 9, fontWeight: '900' }, secondary: { alignItems: 'center', borderColor: '#55555C', borderRadius: 10, borderWidth: 1, flex: 1, paddingVertical: 13 }, secondaryText: { color: '#F4F4F2', fontSize: 9, fontWeight: '900' }, clear: { color: '#77777E', fontSize: 7, fontWeight: '900', letterSpacing: 1, paddingVertical: 15, textAlign: 'right' }, empty: { color: '#68686F', fontSize: 10, paddingTop: 45, textAlign: 'center' }, card: { backgroundColor: '#111113', borderColor: '#303034', borderLeftColor: '#B7F171', borderLeftWidth: 3, borderRadius: 9, borderWidth: 1, marginBottom: 8, padding: 11 }, errorCard: { borderLeftColor: '#FF7780' }, warningCard: { borderLeftColor: '#FFB86B' }, cardTop: { flexDirection: 'row', justifyContent: 'space-between' }, step: { color: '#B7F171', flex: 1, fontFamily: 'monospace', fontSize: 7, fontWeight: '900', letterSpacing: .7 }, time: { color: '#66666D', fontSize: 6 }, message: { color: '#ECECEA', fontSize: 10, lineHeight: 15, marginTop: 6 }, details: { color: '#828289', fontFamily: 'monospace', fontSize: 7, lineHeight: 11, marginTop: 6 },
  panel: { backgroundColor: '#111113', borderColor: '#303034', borderRadius: 11, borderWidth: 1, marginTop: 16, paddingHorizontal: 13, paddingVertical: 12 },
  panelTitle: { color: '#B7F171', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  panelNote: { color: '#77777E', fontSize: 8, lineHeight: 13, marginTop: 6 },
  panelRow: { alignItems: 'center', borderTopColor: '#232327', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginTop: 9, paddingTop: 9 },
  panelLabel: { color: '#ACACB2', flex: 1, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  panelValueGroup: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  panelValue: { color: '#B7F171', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  panelValueBad: { color: '#FF7780' },
  panelFix: { backgroundColor: '#FF7780', borderRadius: 6, paddingHorizontal: 9, paddingVertical: 5 },
  panelFixText: { color: '#101012', fontSize: 7, fontWeight: '900', letterSpacing: 0.6 },
  panelFootnote: { color: '#66666D', fontSize: 7, marginTop: 11 },
  timelineIdentity: { flex: 1, paddingRight: 10 },
  timelineName: { color: '#ECECEA', fontSize: 10, fontWeight: '800' },
  timelineKind: { color: '#77777E', fontSize: 8, fontWeight: '700' },
  timelineTime: { color: '#77777E', fontSize: 8, marginTop: 2 },
});
