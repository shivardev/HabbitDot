import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type ReliabilityStatus = {
  sdkInt: number;
  manufacturer: string;
  model: string;
  canScheduleExactAlarms: boolean;
  exactAlarmsRequireUserConsent: boolean;
  isIgnoringBatteryOptimizations: boolean;
  isDeviceIdleMode: boolean;
  isPowerSaveMode: boolean;
};

type NativeModule = {
  getStatus(): ReliabilityStatus;
  canScheduleExactAlarms(): boolean;
  isIgnoringBatteryOptimizations(): boolean;
  getScheduledAlarmLiveness(identifiers: string[]): Record<string, boolean>;
  openExactAlarmSettings(): void;
  openBatteryOptimizationSettings(): void;
  openNotificationSettings(): void;
  openChannelSettings(channelId: string): void;
  openAppSettings(): void;
  appendLog(line: string): boolean;
  getLogPath(): string;
};

// Optional so Expo Go and the web bundle keep working: they have no native side, and
// every caller already has to cope with an unknown answer there.
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeModule>('HabbitDotReliability') : null;

export const isReliabilityModuleAvailable = native !== null;

export function getReliabilityStatus(): ReliabilityStatus | null {
  try {
    return native?.getStatus() ?? null;
  } catch {
    return null;
  }
}

/** Null when the answer is genuinely unknown, so callers never report a guess as fact. */
export function canScheduleExactAlarms(): boolean | null {
  try {
    return native?.canScheduleExactAlarms() ?? null;
  } catch {
    return null;
  }
}

export function isIgnoringBatteryOptimizations(): boolean | null {
  try {
    return native?.isIgnoringBatteryOptimizations() ?? null;
  } catch {
    return null;
  }
}

export function getScheduledAlarmLiveness(identifiers: string[]): Record<string, boolean> | null {
  try {
    return native?.getScheduledAlarmLiveness(identifiers) ?? null;
  } catch {
    return null;
  }
}

export const openExactAlarmSettings = () => native?.openExactAlarmSettings();
export const openBatteryOptimizationSettings = () => native?.openBatteryOptimizationSettings();
export const openNotificationSettings = () => native?.openNotificationSettings();
export const openChannelSettings = (channelId: string) => native?.openChannelSettings(channelId);
export const openAppSettings = () => native?.openAppSettings();

/**
 * Mirrors a log line to a file on disk. The Logs screen cannot explain a failure that
 * happened while the app was not running; this file can, and adb can read it.
 */
export function appendFileLog(line: string) {
  try {
    native?.appendLog(line);
  } catch {
    // Diagnostics must never take the app down with them.
  }
}

export function getFileLogPath(): string | null {
  try {
    return native?.getLogPath() ?? null;
  } catch {
    return null;
  }
}
