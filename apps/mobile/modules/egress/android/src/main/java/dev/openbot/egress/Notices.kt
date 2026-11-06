package dev.openbot.egress

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ForegroundInfo
import dev.openbot.egress.core.UnavailableReason

/** The phone connection's notifications, all native, so none of them needs JavaScript. */
object Notices {
  /** Same ids, names and importance as the app's channels (`src/push/payload.ts`). */
  const val CONNECTION = "connection"
  const val ASKING = "asking"

  const val ONGOING_ID = 4100
  private const val PAUSED_ID = 4101
  private const val ASK_ID = 4102
  private const val TURNED_OFF_ID = 4103
  private const val WORK_ID = 4104

  fun ensureChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    // Creating an existing channel changes nothing the owner tuned.
    manager.createNotificationChannel(
      NotificationChannel(CONNECTION, "Phone connection", NotificationManager.IMPORTANCE_LOW)
    )
    manager.createNotificationChannel(
      NotificationChannel(ASKING, "Teammates asking for you", NotificationManager.IMPORTANCE_HIGH)
    )
  }

  /** Whether the owner would see these notices: the permission, and each channel left on. */
  data class Allowed(val permission: Boolean, val connection: Boolean, val asking: Boolean)

  fun allowed(context: Context): Allowed {
    ensureChannels(context)
    val manager = context.getSystemService(NotificationManager::class.java)
    fun on(id: String) = manager.getNotificationChannel(id)?.importance != NotificationManager.IMPORTANCE_NONE
    return Allowed(NotificationManagerCompat.from(context).areNotificationsEnabled(), on(CONNECTION), on(ASKING))
  }

  private fun icon(context: Context): Int =
    context.resources.getIdentifier("ic_notification", "drawable", context.packageName).takeIf { it != 0 }
      ?: context.applicationInfo.icon

  /** Opens the app on Settings → Phone connection. */
  private fun openApp(context: Context): PendingIntent =
    PendingIntent.getActivity(
      context,
      0,
      Intent(Intent.ACTION_VIEW, Uri.parse("openbot://phone-connection"))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  /** Starts the service as the owner: tapping a notification may start one from the background. */
  fun startIntent(context: Context): PendingIntent =
    PendingIntent.getForegroundService(
      context,
      1,
      EgressService.intent(context, EgressService.ACTION_USER),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  private fun stopIntent(context: Context): PendingIntent =
    PendingIntent.getService(
      context,
      2,
      EgressService.intent(context, EgressService.ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  fun reasonText(reason: UnavailableReason): String =
    when (reason) {
      UnavailableReason.WIFI_ONLY -> "Paused: not on Wi-Fi"
      UnavailableReason.DATA_CAP -> "Paused: mobile data limit reached"
      UnavailableReason.LOW_BATTERY -> "Paused: battery low"
      UnavailableReason.LOW_POWER_STANDBY -> "Paused: Low Power Standby is on"
      UnavailableReason.STOPPED -> "Stopped"
    }

  /** The foreground service's notification. */
  fun ongoing(context: Context, title: String, text: String?): android.app.Notification {
    ensureChannels(context)
    return NotificationCompat.Builder(context, CONNECTION)
      .setSmallIcon(icon(context))
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(openApp(context))
      .addAction(0, "Stop", stopIntent(context))
      .build()
  }

  /** A short notice that the connection paused, and why. Replaces the previous one. */
  fun paused(context: Context, reason: UnavailableReason) =
    notify(
      context,
      PAUSED_ID,
      NotificationCompat.Builder(context, CONNECTION)
        .setSmallIcon(icon(context))
        .setContentTitle(reasonText(reason))
        .setContentText("Teammates browse from the cloud until this phone can help again.")
        .setAutoCancel(true)
        .setContentIntent(openApp(context))
        .build(),
    )

  fun clearPaused(context: Context) = NotificationManagerCompat.from(context).cancel(PAUSED_ID)

  /** Teammates need this phone, and Android won't let the app start on its own. */
  fun tapToStart(context: Context, title: String, body: String) =
    notify(
      context,
      ASK_ID,
      NotificationCompat.Builder(context, ASKING)
        .setSmallIcon(icon(context))
        .setContentTitle(title)
        .setContentText(body)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setTimeoutAfter(10 * 60 * 1000L)
        .setContentIntent(startIntent(context))
        .build(),
    )

  fun clearTapToStart(context: Context) = NotificationManagerCompat.from(context).cancel(ASK_ID)

  /** The notices about an earlier pairing: a new pairing, or none, makes them out of date. */
  fun clearPairing(context: Context) =
    NotificationManagerCompat.from(context).run {
      cancel(PAUSED_ID)
      cancel(ASK_ID)
      cancel(TURNED_OFF_ID)
    }

  fun turnedOff(context: Context) =
    notify(
      context,
      TURNED_OFF_ID,
      NotificationCompat.Builder(context, CONNECTION)
        .setSmallIcon(icon(context))
        .setContentTitle("The phone connection was turned off")
        .setContentText("Open open-bot to turn it on again.")
        .setAutoCancel(true)
        .setContentIntent(openApp(context))
        .build(),
    )

  /** Only Android 11 and older run expedited work in the foreground (newer ones use a job). */
  fun workForegroundInfo(context: Context): ForegroundInfo {
    ensureChannels(context)
    val notification =
      NotificationCompat.Builder(context, CONNECTION)
        .setSmallIcon(icon(context))
        .setContentTitle("Updating the phone connection")
        .setSilent(true)
        .build()
    return ForegroundInfo(WORK_ID, notification)
  }

  private fun notify(context: Context, id: Int, notification: android.app.Notification) {
    ensureChannels(context)
    try {
      NotificationManagerCompat.from(context).notify(id, notification)
    } catch (_: SecurityException) {
      // No notification permission: the app shows the problem on Phone connection.
    }
  }
}
