# Notification reliability journal

## 2026-09-01 — 11:00 medication reminder investigation

Reported symptom: a medication reminder expected around 11:00 appears intermittently.

Evidence collected from the attached Android phone (`NX789J`) at 11:08 EDT:

- HabbitDot 1.0.2 (versionCode 4) is installed.
- `POST_NOTIFICATIONS` is granted.
- Android's `important-habit-reminders-v2` channel exists, is enabled, and has maximum importance, sound, vibration, and alarm audio usage.
- Android AlarmManager recorded HabbitDot's notification alarm firing at 10:55 (about 13 minutes before inspection). It had three historical wakeups for `expo.modules.notifications.NOTIFICATION_EVENT`.
- AlarmManager already contained the next exact `RTC_WAKEUP` for 2026-09-02 at 10:55. This proves the reminder was scheduled and its native receiver ran today.
- Do Not Disturb / Bedtime mode had ended at 09:00, so it was not suppressing the 10:55 occurrence.
- The notification was not present in the active notification records when inspected at 11:08. Android's retained dump did not provide enough evidence to distinguish presentation failure from dismissal or notification-assistant removal.

Conclusion: this occurrence was not a scheduling failure. The failure happened after Android triggered the alarm, in the presentation/notification-tray stage. The old app had no durable event journal, so the final sub-step could not be reconstructed after the fact.

Changes made:

- Added a persistent diagnostic log (capped at 1,000 entries).
- Added a Logs screen showing app startup, permission/channel checks, every reminder accepted by Expo, scheduling failures, foreground presentation decisions/results, notification receipt callbacks, and notification actions.
- Added pull-to-refresh diagnostics containing Android's current channel and scheduled-trigger snapshot.
- Added a user-triggered notification test scheduled 10 seconds ahead.

Next reproduction procedure:

1. Open Logs and tap **CHECK NOW**. Confirm the expected reminder and time appear in `diagnostics.snapshot`.
2. Tap **TEST IN 10 SEC**, background or foreground the app as desired, and wait without dismissing the notification.
3. After any missed reminder, open Logs and preserve the entries around its scheduled time. A `presentation.failed` entry identifies Expo's foreground three-second presentation failure; `notification.received` confirms the JS process observed delivery; the scheduled snapshot confirms whether Android still owns the trigger.

## On-device verification

- Release APK built successfully through WSL and installed with `adb install -r`.
- Android's credential-encrypted data inode remained `407360` before and after installation, and the existing two habits and history were visible after launch; app data was preserved.
- The Logs tab rendered existing `app.started`, `configure.started`, `schedule.accepted`, and `configure.finished` entries. It reported the active Finasteride reminder as accepted for 11:00 daily (`habit-reminder-9`).
- The **TEST IN 10 SEC** action produced an active Android notification on the maximum-importance channel. Android reported `numEnqueuedByApp=1` and `numPostedByApp=1` for this test.
- No AndroidRuntime, React Native, or Expo errors occurred during launch and the test.

## 2026-09-08 — root cause found: the alarm was never exact

The 11:00 Finasteride reminder was missed again. This time the phone had enough
evidence to name the cause.

### Evidence

`dumpsys alarm` on `NX789J` (Android 15, SDK 35) showed HabbitDot's pending alarm as:

```
RTC_WAKEUP #63 ... app.habbitdot.mobile
  tag=*walarm*:expo.modules.notifications.NOTIFICATION_EVENT
  type=RTC_WAKEUP origWhen=2026-09-09 10:59:30 window=0 flags=0x20
```

Two things are missing that a real exact alarm has. There is no `exactAllowReason`
field, and `flags=0x20` is `FLAG_ALLOW_WHILE_IDLE_COMPAT`. A genuinely exact alarm on
the same device (`com.google.android.googlequicksearchbox`) read
`exactAllowReason=permission ... flags=0x9`. Android was treating the medication
reminder as an **inexact** alarm: free to batch it with other apps' alarms, jitter it,
and defer it under Doze and app-standby quota. That is exactly the "works most days,
silently missing on others" pattern in the entries above.

### Why

`expo-notifications` downgrades silently. From
`node_modules/expo-notifications/.../ExpoSchedulingDelegate.kt`:

```kotlin
if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()) {
  AlarmManagerCompat.setExactAndAllowWhileIdle(...)
} else {
  AlarmManagerCompat.setAndAllowWhileIdle(...)   // inexact
}
```

The app targets SDK 36. Since Android 14, `SCHEDULE_EXACT_ALARM` is denied by default
for apps targeting 33+, and HabbitDot never checked for it or asked. So
`canScheduleExactAlarms()` returned false, the `else` branch was taken, and every layer
above it still reported success: the permission was granted, the channel was at maximum
importance, and `getAllScheduledNotificationsAsync()` returned the reminder. Nothing in
the app could see the downgrade, because expo-notifications exposes no JavaScript API
for exact-alarm state. That is why five earlier investigations stalled at "scheduled but
not delivered".

### Fixes

- `USE_EXACT_ALARM` added to `app.json`. It is granted at install, so exact alarms work
  with no user action. **If HabbitDot is ever published to Play, this needs a policy
  declaration or removal** — the runtime request path below covers that case.
- New local native module `modules/habbitdot-reliability` exposing what expo does not:
  `canScheduleExactAlarms`, `isIgnoringBatteryOptimizations`, power-save state, and
  deep links into the exact-alarm, battery, channel and notification settings screens.
- Reminder health is now a first-class verdict (`NotificationHealth.issues`). A blocked
  exact alarm is an error, not a silent downgrade, and surfaces as a home-screen banner
  and a row in the Logs screen with a one-tap fix.
- Follow-up nags: each reminder schedules N extra daily alarms at a configurable gap
  (default 2 × 15 min), so one dropped notification is no longer a missed dose. They are
  suppressed at presentation time when the dose is already logged rather than
  unscheduled, so tomorrow's alarm always survives.
- Catch-up notification and a "DUE AND NOT LOGGED" home banner, both driven by
  "the time passed and nothing is recorded". Neither depends on any inference about
  whether Android delivered anything.
- Delivery journal (`reminder_deliveries`): every occurrence the app asked Android for,
  and what became of it. Occurrences the app could not witness are recorded as
  `unconfirmed`, never `missed` — the received-listener only runs while the JS process
  is alive, so silence proves nothing about delivery.
- Per-reminder customisation: notification title, message, snooze length, follow-up
  count and gap.

### Bugs found while testing on the device

- Catch-up notifications posted with `trigger: null` landed on
  `expo_notifications_fallback_notification_channel` at importance 4. Expo carries the
  channel on the *trigger*, so an immediate notification has none. The plugin's
  `defaultChannel` option only sets the Firebase default, which does not apply to local
  notifications. Fixed by giving the catch-up a 1-second interval trigger with an
  explicit `channelId`; verified at importance 5 on `important-habit-reminders-v2`.
- `TAKEN` used `opensAppToForeground: false`. Expo queues background action responses in
  `NotificationManager.pendingNotificationResponses`, an in-memory list in a process-local
  singleton, so pressing Done while the app was killed dropped the dose silently. Done now
  opens the app, which on Android 12+ uses an Activity PendingIntent
  (`createPendingIntentForOpeningApp`) and is the only path that guarantees the write.
  Snooze stays in the background: losing one only costs a re-nudge.
- Re-arming on every reminder edit made the 15-minute stepper drop taps, and a debounced
  reconcile could overlap a habit save. `replaceHabitReminders` used
  `withTransactionAsync`, which expo-sqlite documents as unsafe under concurrent use — the
  overlap deadlocked the save, leaving the editor permanently stuck on "saving". Fixed with
  `withExclusiveTransactionAsync` plus a serialised reconcile queue.

### Verified on device

- Release APK built through WSL, installed with `adb install -r`. Signature `51ed3f60`
  and `ceDataInode=407360` unchanged across four reinstalls; both habits and all history
  intact.
- All three Finasteride alarms now read
  `exactAllowReason=policy_permission ... flags=0x5` — real `setExactAndAllowWhileIdle`.
- Logs screen reports `EXACT ALARMS ALLOWED YES`, `REMINDERS ARMED 3 OF 3`, and flags
  battery optimisation as a warning with a working FIX button.
- The catch-up path fired for the dose actually missed on 2026-09-08 and posted a
  notification with both action buttons; the timeline recorded it as `catchup DELIVERED`.
- Deleting a reminder cancels its alarms; the alarm set drops back to three.

### Still unverified

- Pressing Done / Snooze, and tapping a reminder to open the app, have not been exercised
  against a live reminder — doing so would have meant logging a medication dose that was
  not taken. The next real reminder at 11:00 is the proof point.
- Reboot restoration relies on expo's `BOOT_COMPLETED` receiver, which is registered in
  the manifest but was not exercised.
- Note that a force-stop (manual, or by an aggressive OEM battery manager) cancels all of
  an app's alarms until it is next opened. The reconcile on launch and on foreground
  restores them, but nothing can restore them while the app stays stopped.
