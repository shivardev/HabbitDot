import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import { getEnabledReminders, incrementEntry } from './database';

const CHANNEL_ID = 'habit-reminders';
const CATEGORY_ID = 'habit_reminder';
const SCHEDULE_DAYS = 30;
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const localDateKey = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export async function configureNotifications() {
  if (isExpoGo) return false;
  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }) });
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL_ID, { name: 'Habit reminders', description: 'Scheduled reminders for habits', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 150, 250], lightColor: '#B7F171', sound: 'default' });
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    { identifier: 'TAKEN', buttonTitle: 'Taken', options: { opensAppToForeground: false } },
    { identifier: 'SNOOZE', buttonTitle: 'Remind in 10 min', options: { opensAppToForeground: false } },
  ]);
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') return false;
  await Notifications.cancelAllScheduledNotificationsAsync();
  const today = localDateKey();
  const reminders = await getEnabledReminders(today);
  const now = new Date();
  for (const reminder of reminders) {
    for (let dayOffset = 0; dayOffset < SCHEDULE_DAYS; dayOffset += 1) {
      if (dayOffset === 0 && reminder.todayCount >= reminder.dailyGoal) continue;
      const occurrence = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, reminder.hour, reminder.minute, 0, 0);
      if (occurrence <= now) continue;
      await Notifications.scheduleNotificationAsync({ content: { title: reminder.name, body: 'Time for your habit check-in.', categoryIdentifier: CATEGORY_ID, data: { habitId: reminder.habitId }, sound: 'default' }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: occurrence, channelId: CHANNEL_ID } });
    }
  }
  return true;
}

export async function listenForNotificationActions(onChanged: () => void) {
  if (isExpoGo) return null;
  const Notifications = await import('expo-notifications');
  return Notifications.addNotificationResponseReceivedListener(async (response) => {
    const habitId = Number(response.notification.request.content.data?.habitId);
    if (!habitId) return;
    if (response.actionIdentifier === 'TAKEN') { await incrementEntry(habitId, localDateKey()); await configureNotifications(); onChanged(); }
    else if (response.actionIdentifier === 'SNOOZE') await Notifications.scheduleNotificationAsync({ content: { title: response.notification.request.content.title ?? 'Habit reminder', body: 'Your 10-minute reminder.', categoryIdentifier: CATEGORY_ID, data: { habitId }, sound: 'default' }, trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 600, channelId: CHANNEL_ID } });
  });
}
