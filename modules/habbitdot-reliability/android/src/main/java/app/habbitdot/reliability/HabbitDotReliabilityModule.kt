package app.habbitdot.reliability

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Android reliability facts that expo-notifications does not surface to JavaScript.
 *
 * The reminder that reaches the user is only as reliable as the alarm behind it.
 * expo-notifications silently downgrades to an inexact alarm when the app cannot
 * schedule exact ones (ExpoSchedulingDelegate.setupAlarm), and an inexact alarm is
 * free to be batched, jittered and deferred by Doze. Without these checks the app
 * cannot tell the difference between "scheduled" and "scheduled and will actually
 * fire on time", which is exactly how a medication reminder goes missing.
 */
class HabbitDotReliabilityModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val alarmManager: AlarmManager
    get() = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private val powerManager: PowerManager
    get() = context.getSystemService(Context.POWER_SERVICE) as PowerManager

  override fun definition() = ModuleDefinition {
    Name("HabbitDotReliability")

    Function("getStatus") {
      mapOf(
        "sdkInt" to Build.VERSION.SDK_INT,
        "manufacturer" to Build.MANUFACTURER,
        "model" to Build.MODEL,
        "canScheduleExactAlarms" to canScheduleExactAlarms(),
        "exactAlarmsRequireUserConsent" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
        "isIgnoringBatteryOptimizations" to isIgnoringBatteryOptimizations(),
        "isDeviceIdleMode" to powerManager.isDeviceIdleMode,
        "isPowerSaveMode" to powerManager.isPowerSaveMode
      )
    }

    Function("canScheduleExactAlarms") { canScheduleExactAlarms() }

    Function("isIgnoringBatteryOptimizations") { isIgnoringBatteryOptimizations() }

    // expo-notifications reports its SharedPreferences store, not AlarmManager. A force-stop
    // can remove the actual alarms while leaving that store untouched. Recreate the exact
    // Intent identity Expo uses and ask PendingIntent whether each alarm token still exists.
    Function("getScheduledAlarmLiveness") { identifiers: List<String> ->
      identifiers.associateWith { hasScheduledAlarm(it) }
    }

    // Settings > Apps > HabbitDot > Alarms & reminders. Only reachable from S onwards;
    // below that exact alarms need no consent and the app settings page is the useful target.
    Function("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        startSettings(
          Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri()),
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri())
        )
      } else {
        startSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri()))
      }
    }

    // The list of battery-optimised apps. Deliberately not ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS:
    // that dialog needs the REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission, which Play restricts.
    Function("openBatteryOptimizationSettings") {
      startSettings(
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri())
      )
    }

    Function("openNotificationSettings") {
      startSettings(
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri())
      )
    }

    Function("openChannelSettings") { channelId: String ->
      startSettings(
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
          .putExtra(Settings.EXTRA_CHANNEL_ID, channelId),
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      )
    }

    // Mirrors the in-app diagnostic log to <externalFiles>/diagnostics.log. The Logs screen
    // is unreadable when the failure is "the app was never running", and this file survives
    // the process dying, so a missed reminder can be reconstructed over adb afterwards.
    Function("appendLog") { line: String ->
      try {
        val file = File(context.getExternalFilesDir(null), "diagnostics.log")
        if (file.length() > 4_000_000) file.delete()
        file.appendText(line + "\n")
        true
      } catch (e: Exception) {
        Log.w("HabbitDotReliability", "Could not append to the diagnostics file", e)
        false
      }
    }

    Function("getLogPath") {
      File(context.getExternalFilesDir(null), "diagnostics.log").absolutePath
    }

    Function("openAppSettings") {
      startSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri()))
    }
  }

  private fun canScheduleExactAlarms() =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()

  private fun isIgnoringBatteryOptimizations() =
    powerManager.isIgnoringBatteryOptimizations(context.packageName)

  private fun hasScheduledAlarm(identifier: String): Boolean {
    val action = "expo.modules.notifications.NOTIFICATION_EVENT"
    val intent = Intent(
      action,
      Uri.parse("expo-notifications://notifications/").buildUpon()
        .appendPath("scheduled")
        .appendPath(identifier)
        .appendPath("trigger")
        .build()
    )
    val receiver = context.packageManager
      .queryBroadcastReceivers(Intent(action).setPackage(context.packageName), 0)
      .firstOrNull()?.activityInfo ?: return false
    intent.component = ComponentName(receiver.packageName, receiver.name)
    val mutableFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    return PendingIntent.getBroadcast(
      context,
      receiver.name.hashCode(),
      intent,
      PendingIntent.FLAG_NO_CREATE or mutableFlag
    ) != null
  }

  private fun packageUri(): Uri = Uri.fromParts("package", context.packageName, null)

  /** Tries each intent in turn so an OEM that removed a settings screen still lands somewhere useful. */
  private fun startSettings(vararg intents: Intent) {
    val activity = appContext.currentActivity
    for (intent in intents) {
      if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        (activity ?: context).startActivity(intent)
        return
      } catch (_: Exception) {
        // Screen is unavailable on this device; fall through to the next candidate.
      }
    }
    throw IllegalStateException("No settings screen on this device could handle the request.")
  }
}
