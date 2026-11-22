package dev.openbot.runprogress

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.annotation.VisibleForTesting
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

private const val TAG = "RunProgress"

/**
 * A running teammate's progress notification, drawn natively: `run-progress` pushes arrive at
 * normal priority, when Android may not start the app's JavaScript, so nothing here needs it.
 * Android 16 draws it with `Notification.ProgressStyle`; older versions get a standard progress
 * bar. The egress module's FCM service hands these pushes here; the app's JavaScript does too for
 * development builds, which have no FCM, and tells it which chat is on screen.
 */
object RunProgress {
  /** Same id, name and importance as the app's channel (`src/push/payload.ts`). */
  const val CHANNEL = "running"
  /** Every run's notification has this id and its own tag (`run-progress:<run>`). */
  private const val NOTIFICATION_ID = 4200
  private const val GROUP = "running"
  private const val PREFS = "openbot_run_progress"
  const val ACTION_DISMISSED = "dev.openbot.runprogress.DISMISSED"

  /** The chat open on screen while the app is in front, set by the app's JavaScript. */
  @Volatile private var visibleChat: String? = null
  private val lock = Any()
  /** The time, in ms; tests set their own. */
  @VisibleForTesting internal var clock: () -> Long = System::currentTimeMillis

  /** Handles a `run-progress` push. Returns false for anything that isn't one. */
  fun onPush(context: Context, data: Map<String, String>): Boolean {
    val update = ProgressUpdate.parse(data) ?: return false
    synchronized(lock) {
      val (action, entry) = ProgressRules.decide(read(context, update.runId), update, visibleChat, clock())
      // Written at once: the process that got the push may be gone right after.
      if (entry != null) prefs(context).edit().putString(update.runId, entry.encode()).commit()
      forgetOld(context)
      when (action) {
        Action.SHOW -> show(context, update, ProgressRules.TIMEOUT_MS)
        Action.REMOVE, Action.HIDE -> cancel(context, update.tag)
        Action.IGNORE -> {}
      }
    }
    return true
  }

  /** The run's result was shown: its progress goes, and stays gone. */
  fun endRun(context: Context, runId: String) {
    synchronized(lock) {
      val entry = ProgressRules.ended(read(context, runId), clock())
      prefs(context).edit().putString(runId, entry.encode()).commit()
      cancel(context, tagOf(runId))
    }
  }

  /**
   * You swiped a run's notification away: later updates don't bring it back. Android removed the
   * card before this runs, so an update drawn in between is removed here, in the same lock that
   * records the swipe.
   */
  fun dismissed(context: Context, runId: String) {
    synchronized(lock) {
      ProgressRules.dismissed(read(context, runId), clock())?.let {
        prefs(context).edit().putString(runId, it.encode()).commit()
      }
      cancel(context, tagOf(runId))
    }
  }

  /**
   * The chat on screen, or null. Its runs' notifications go while you look at it, and come back,
   * from their latest update, when it leaves the screen: you pressed Home or opened another one.
   */
  fun setVisibleChat(context: Context, chatId: String?) {
    synchronized(lock) {
      visibleChat = chatId
      val entries = entries(context)
      if (chatId != null)
        for ((runId, entry) in entries) if (!entry.ended && entry.chatId == chatId) cancel(context, tagOf(runId))
      val active = activeTags(context)
      for ((update, left) in ProgressRules.showing(entries, chatId, clock()).values)
        if (update.tag !in active) show(context, update, left)
    }
  }

  private fun tagOf(runId: String) = "run-progress:$runId"

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun read(context: Context, runId: String) = LedgerEntry.decode(prefs(context).getString(runId, null))

  private fun entries(context: Context): Map<String, LedgerEntry> =
    prefs(context).all.mapNotNull { (key, value) -> LedgerEntry.decode(value as? String)?.let { key to it } }.toMap()

  /** The progress notifications on screen now, by tag. */
  private fun activeTags(context: Context): Set<String> =
    context.getSystemService(NotificationManager::class.java).activeNotifications
      .filter { it.id == NOTIFICATION_ID }
      .mapNotNull { it.tag }
      .toSet()

  private fun forgetOld(context: Context) {
    val prefs = prefs(context)
    val entries = entries(context)
    val forget = ProgressRules.forget(entries, clock())
    if (forget.isEmpty()) return
    val editor = prefs.edit()
    forget.forEach { editor.remove(it) }
    editor.commit()
  }

  private fun cancel(context: Context, tag: String) = NotificationManagerCompat.from(context).cancel(tag, NOTIFICATION_ID)

  private fun ensureChannel(context: Context) {
    // Creating an existing channel changes nothing the owner tuned.
    val channel = NotificationChannel(CHANNEL, "Running work", NotificationManager.IMPORTANCE_LOW)
    channel.enableVibration(false)
    channel.setSound(null, null)
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  /** Off in Android's settings (the app's notifications or this channel): nothing to draw. */
  private fun allowed(context: Context): Boolean {
    val manager = context.getSystemService(NotificationManager::class.java)
    return NotificationManagerCompat.from(context).areNotificationsEnabled() &&
      manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
  }

  /** Draws the update; it removes itself after `timeoutMs` unless a newer one replaces it. */
  private fun show(context: Context, update: ProgressUpdate, timeoutMs: Long) {
    ensureChannel(context)
    if (!allowed(context)) return
    val view = ProgressView.of(update)
    val notification =
      if (Build.VERSION.SDK_INT >= 36) progressStyle(context, update, view, timeoutMs)
      else compat(context, update, view, timeoutMs)
    try {
      NotificationManagerCompat.from(context).notify(update.tag, NOTIFICATION_ID, notification)
    } catch (error: SecurityException) {
      Log.w(TAG, "No permission to notify", error)
    }
  }

  private fun icon(context: Context): Int =
    context.resources.getIdentifier("ic_notification", "drawable", context.packageName).takeIf { it != 0 }
      ?: context.applicationInfo.icon

  /** Each run gets its own pending intents, so tapping one opens that run. */
  private fun requestCode(update: ProgressUpdate) = update.runId.hashCode()

  private fun openIntent(context: Context, update: ProgressUpdate, view: ProgressView): PendingIntent =
    PendingIntent.getActivity(
      context,
      requestCode(update),
      Intent(Intent.ACTION_VIEW, Uri.parse(view.link))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  private fun deleteIntent(context: Context, update: ProgressUpdate): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      requestCode(update),
      Intent(context, RunProgressDismissReceiver::class.java)
        .setAction(ACTION_DISMISSED)
        .putExtra("runId", update.runId),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  @RequiresApi(36)
  private fun progressStyle(context: Context, update: ProgressUpdate, view: ProgressView, timeoutMs: Long): Notification {
    val builder = Notification.Builder(context, CHANNEL)
    builder
      .setSmallIcon(icon(context))
      .setContentTitle(view.title)
      .setContentText(view.body.ifBlank { null })
      .setColor(view.color)
      .setOngoing(ProgressView.ongoing(Build.VERSION.SDK_INT))
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setGroup(GROUP)
      .setTimeoutAfter(timeoutMs)
      .setContentIntent(openIntent(context, update, view))
      .setDeleteIntent(deleteIntent(context, update))
      .setLocalOnly(true)
    view.startedAt?.let { builder.setWhen(it).setShowWhen(true).setUsesChronometer(true) }
    view.bar?.let { bar ->
      val style = Notification.ProgressStyle().setStyledByProgress(true)
      if (bar.indeterminate) {
        style.setProgressIndeterminate(true)
        style.setProgressSegments(listOf(Notification.ProgressStyle.Segment(1).setColor(view.color)))
      } else {
        style.setProgressSegments(List(bar.segments) { Notification.ProgressStyle.Segment(1).setColor(view.color) })
        style.setProgress(bar.done)
      }
      builder.setStyle(style)
    }
    return builder.build()
  }

  private fun compat(context: Context, update: ProgressUpdate, view: ProgressView, timeoutMs: Long): Notification {
    val builder = NotificationCompat.Builder(context, CHANNEL)
    builder
      .setSmallIcon(icon(context))
      .setContentTitle(view.title)
      .setContentText(view.body.ifBlank { null })
      .setColor(view.color)
      .setOngoing(ProgressView.ongoing(Build.VERSION.SDK_INT))
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setGroup(GROUP)
      .setTimeoutAfter(timeoutMs)
      .setContentIntent(openIntent(context, update, view))
      .setDeleteIntent(deleteIntent(context, update))
      .setLocalOnly(true)
    view.startedAt?.let { builder.setWhen(it).setShowWhen(true).setUsesChronometer(true) }
    view.bar?.let { builder.setProgress(it.segments, it.done, it.indeterminate) }
    return builder.build()
  }
}

/** Your swipe on a run's notification (its delete intent; only the app can send it). */
class RunProgressDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != RunProgress.ACTION_DISMISSED) return
    val runId = intent.getStringExtra("runId") ?: return
    RunProgress.dismissed(context, runId)
  }
}
