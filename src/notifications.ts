import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getEnabledReminders, incrementEntry } from './database';

const CHANNEL_ID = 'habit-reminders';
const CATEGORY_ID = 'habit_reminder';
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Expo discards a foreground notification when no handler is registered within
// three seconds. Register it as soon as this module loads.
if (!isExpoGo) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
    handleError: (_notificationId, error) => console.error('Notification presentation failed', error),
  });
}

const localDateKey = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export async function configureNotifications() {
  if (isExpoGo) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Habit reminders',
      description: 'Scheduled reminders for habits',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
      lightColor: '#B7F171',
      sound: 'default',
    });
  }

  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    { identifier: 'TAKEN', buttonTitle: 'Taken', options: { opensAppToForeground: false } },
    { identifier: 'SNOOZE', buttonTitle: 'Remind in 10 min', options: { opensAppToForeground: false } },
  ]);

  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') return false;

  const reminders = await getEnabledReminders(localDateKey());
  await Notifications.cancelAllScheduledNotificationsAsync();

  // Native daily triggers survive long idle periods and are restored by
  // expo-notifications after reboot. They also avoid a large rolling set of
  // one-off alarms that can be pruned by aggressive Android firmware.
  for (const reminder of reminders) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: reminder.name,
        body: 'Time for your habit check-in.',
        categoryIdentifier: CATEGORY_ID,
        data: { habitId: reminder.habitId },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: reminder.hour,
        minute: reminder.minute,
        channelId: CHANNEL_ID,
      },
    });
  }

  return true;
}

export async function scheduleDeliveryVerification() {
  if (isExpoGo) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'HabbitDot reminders are ready',
      body: 'This one-time check confirms background notifications are working.',
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
}

export async function listenForNotificationActions(onChanged: () => void) {
  if (isExpoGo) return null;
  return Notifications.addNotificationResponseReceivedListener(async (response) => {
    const habitId = Number(response.notification.request.content.data?.habitId);
    if (!habitId) return;
    if (response.actionIdentifier === 'TAKEN') {
      await incrementEntry(habitId, localDateKey());
      onChanged();
    } else if (response.actionIdentifier === 'SNOOZE') {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: response.notification.request.content.title ?? 'Habit reminder',
          body: 'Your 10-minute reminder.',
          categoryIdentifier: CATEGORY_ID,
          data: { habitId },
          sound: 'default',
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 600,
          channelId: CHANNEL_ID,
        },
      });
    }
  });
}
