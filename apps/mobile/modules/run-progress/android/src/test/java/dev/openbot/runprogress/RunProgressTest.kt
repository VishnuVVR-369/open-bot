package dev.openbot.runprogress

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.time.Instant

/**
 * The notification itself, drawn and removed through Android's notification manager, on the
 * oldest Android the app runs on (minSdk 29) and on Android 13.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 33])
class RunProgressTest {
  private val context: Context = ApplicationProvider.getApplicationContext<Application>()
  private val manager = context.getSystemService(NotificationManager::class.java)
  private var now = Instant.parse("2026-11-22T10:00:20Z").toEpochMilli()
  /** This sign-in's registration, which the worker puts in every push. */
  private lateinit var registration: String
  private val ledger get() = context.getSharedPreferences("openbot_run_progress", Context.MODE_PRIVATE)

  private fun push(
    runId: String,
    sentAt: String,
    state: String = "working",
    chatId: String = "c1",
    registration: String? = this.registration,
  ) =
    RunProgress.onPush(
      context,
      buildMap {
        registration?.let { put("registration", it) }
        put("type", "run-progress")
        put("tag", "run-progress:$runId")
        put("runId", runId)
        put("runState", state)
        put("sentAt", sentAt)
        put("chatId", chatId)
        put("url", "/chats/$chatId?run=$runId")
        if (state != "ended") put("title", "Rex: Book the flight")
        if (state != "ended") put("body", "Running a command")
      },
    )

  private fun shown(): Map<String, Notification> =
    manager.activeNotifications.filter { it.id == 4200 }.associate { it.tag to it.notification }

  /** A run's notification's delete intent, as Android sends it on a swipe or a timeout. */
  private fun deleted(runId: String, expiresAt: Long?) {
    context.sendBroadcast(
      Intent(context, RunProgressDismissReceiver::class.java)
        .setAction(RunProgress.ACTION_DISMISSED)
        .putExtra("runId", runId)
        .apply { expiresAt?.let { putExtra(RunProgress.EXTRA_EXPIRES_AT, it) } },
    )
    ShadowLooper.idleMainLooper()
  }

  /** When the run's drawn card times out, from the delete intent it carries. */
  private fun expiresAt(runId: String): Long =
    shadowOf(shown()["run-progress:$runId"]!!.deleteIntent).savedIntent.getLongExtra(RunProgress.EXTRA_EXPIRES_AT, -1)

  @Before
  fun setUp() {
    RunProgress.clock = { now }
    registration = RunProgress.registration(context)
    RunProgress.setVisibleChat(context, null)
  }

  @After
  fun tearDown() {
    RunProgress.setVisibleChat(context, null)
    RunProgress.clock = System::currentTimeMillis
    manager.cancelAll()
    ledger.edit().clear().commit()
  }

  @Test
  fun comesBackWhenItsChatLeavesTheScreenWithoutAnotherPush() {
    RunProgress.setVisibleChat(context, "c1")
    push("r1", "2026-11-22T10:00:20Z")
    push("r2", "2026-11-22T10:00:21Z", chatId = "c2")
    assertEquals(setOf("run-progress:r2"), shown().keys)
    // You press Home: the chat is no longer on screen.
    now += 60_000
    RunProgress.setVisibleChat(context, null)
    assertEquals(setOf("run-progress:r1", "run-progress:r2"), shown().keys)
    assertEquals("Rex: Book the flight", shown()["run-progress:r1"]!!.extras.getString(Notification.EXTRA_TITLE))
    // Opening the chat hides it again, and another chat brings it back.
    RunProgress.setVisibleChat(context, "c1")
    assertEquals(setOf("run-progress:r2"), shown().keys)
    RunProgress.setVisibleChat(context, "c2")
    assertEquals(setOf("run-progress:r1"), shown().keys)
  }

  @Test
  fun neverComesBackEndedDismissedOrTimedOut() {
    RunProgress.setVisibleChat(context, "c1")
    push("ended", "2026-11-22T10:00:20Z")
    push("ended", "2026-11-22T10:00:40Z", state = "ended")
    push("result", "2026-11-22T10:00:20Z")
    RunProgress.endRun(context, "result")
    push("swiped", "2026-11-22T10:00:20Z")
    RunProgress.dismissed(context, "swiped")
    push("stale", "2026-11-22T10:00:20Z")
    now += ProgressRules.TIMEOUT_MS
    push("fresh", "2026-11-22T10:30:20Z")
    RunProgress.setVisibleChat(context, null)
    assertEquals(setOf("run-progress:fresh"), shown().keys)
  }

  @Test
  fun aSwipeRemovesAnUpdateDrawnBeforeItWasRecorded() {
    push("r1", "2026-11-22T10:00:20Z")
    // You swipe it away; before the delete intent arrives, an update draws it again.
    manager.cancel("run-progress:r1", 4200)
    push("r1", "2026-11-22T10:00:35Z")
    assertEquals(setOf("run-progress:r1"), shown().keys)
    deleted("r1", expiresAt("r1"))
    assertEquals(emptySet<String>(), shown().keys)
    // Later updates stay hidden, even when its chat leaves the screen.
    push("r1", "2026-11-22T10:00:50Z")
    RunProgress.setVisibleChat(context, "c9")
    assertEquals(emptySet<String>(), shown().keys)
  }

  @Test
  fun showsUpdatesThenGoesForGoodWithTheEndOrTheResult() {
    push("r1", "2026-11-22T10:00:20Z", chatId = "c1")
    push("r2", "2026-11-22T10:00:20Z", chatId = "c2")
    push("r1", "2026-11-22T10:00:35Z", state = "waiting", chatId = "c1")
    assertEquals(setOf("run-progress:r1", "run-progress:r2"), shown().keys)
    // The end, and the result notification for a run whose end hasn't arrived.
    push("r1", "2026-11-22T10:00:50Z", state = "ended")
    RunProgress.endRun(context, "r2")
    assertEquals(emptySet<String>(), shown().keys)
    // The ledger read back: neither comes back, whatever arrives late.
    push("r1", "2026-11-22T10:01:05Z")
    push("r2", "2026-11-22T10:01:05Z", chatId = "c2")
    RunProgress.setVisibleChat(context, "c9")
    assertEquals(emptySet<String>(), shown().keys)
  }

  @Test
  fun signingOutRemovesEveryRunAndWhatTheLedgerKeptToRedrawIt() {
    RunProgress.setVisibleChat(context, "c1")
    push("hidden", "2026-11-22T10:00:20Z", chatId = "c1")
    push("drawn", "2026-11-22T10:00:20Z", chatId = "c2")
    assertEquals(setOf("run-progress:drawn"), shown().keys)
    RunProgress.reset(context)
    assertEquals(emptySet<String>(), shown().keys)
    assertEquals(emptyMap<String, Any>(), ledger.all)
    // Signed in again, the chat leaves the screen: the run you can't see any more isn't drawn.
    registration = RunProgress.registration(context)
    RunProgress.setVisibleChat(context, null)
    assertEquals(emptySet<String>(), shown().keys)
    // A new account's runs still show.
    push("next", "2026-11-22T10:00:40Z", chatId = "c3")
    assertEquals(setOf("run-progress:next"), shown().keys)
  }

  @Test
  fun aPushForASignInThePhoneLeftDrawsNothingThenOrAfterTheNextSignIn() {
    val old = registration
    push("r1", "2026-11-22T10:00:20Z")
    // You sign out while FCM already handed the app another of the old account's pushes.
    RunProgress.reset(context)
    assertTrue(push("r1", "2026-11-22T10:00:35Z", registration = old))
    push("r2", "2026-11-22T10:00:35Z", registration = old)
    RunProgress.endRun(context, "r3")
    assertEquals(emptySet<String>(), shown().keys)
    assertEquals(emptyMap<String, Any>(), ledger.all)
    // You sign in again: a new registration, and the old one's pushes still draw nothing.
    registration = RunProgress.registration(context)
    assertTrue(registration != old)
    assertEquals(registration, RunProgress.registration(context))
    push("r1", "2026-11-22T10:00:50Z", registration = old)
    push("r4", "2026-11-22T10:00:50Z", registration = null)
    assertEquals(emptySet<String>(), shown().keys)
    push("r5", "2026-11-22T10:00:50Z")
    assertEquals(setOf("run-progress:r5"), shown().keys)
    // The app's own pushes (development builds) need only that you're signed in.
    RunProgress.onPush(context, mapOf("type" to "run-progress", "tag" to "run-progress:r6", "runId" to "r6", "runState" to "working", "sentAt" to "2026-11-22T10:00:50Z", "title" to "Rex is working"), fromApp = true)
    assertEquals(setOf("run-progress:r5", "run-progress:r6"), shown().keys)
  }

  @Test
  fun aTimeoutIsNoSwipeSoTheNextUpdateShowsItAgain() {
    push("r1", "2026-11-22T10:00:20Z")
    val expiry = expiresAt("r1")
    assertEquals(now + ProgressRules.TIMEOUT_MS, expiry)
    // No keepalive arrived for 30 minutes: Android removes it, and sends its delete intent.
    now = expiry
    manager.cancel("run-progress:r1", 4200)
    deleted("r1", expiry)
    push("r1", "2026-11-22T10:40:20Z")
    assertEquals(setOf("run-progress:r1"), shown().keys)
  }

  @Test
  fun aLateTimeoutLeavesTheUpdateThatCameAfterIt() {
    push("r1", "2026-11-22T10:00:20Z")
    val expiry = expiresAt("r1")
    now = expiry
    manager.cancel("run-progress:r1", 4200)
    // A new update draws it again before the timeout's delete intent arrives.
    push("r1", "2026-11-22T10:40:20Z")
    deleted("r1", expiry)
    assertEquals(setOf("run-progress:r1"), shown().keys)
    // A swipe on the new card still counts.
    deleted("r1", expiresAt("r1"))
    push("r1", "2026-11-22T10:40:35Z")
    assertEquals(emptySet<String>(), shown().keys)
  }

  @Test
  fun resultsForgetOldRunsLikeUpdatesDo() {
    RunProgress.endRun(context, "old")
    now += ProgressRules.FORGET_AFTER_MS + 1
    repeat(ProgressRules.MAX_ENTRIES + 20) {
      now += 1
      RunProgress.endRun(context, "r$it")
    }
    val runs = ledger.all.keys.filter { !it.startsWith("@") }
    assertEquals(ProgressRules.MAX_ENTRIES, runs.size)
    assertFalse("old" in runs)
    assertTrue("r${ProgressRules.MAX_ENTRIES + 19}" in runs)
    // Signing in is kept apart from the runs it forgets.
    assertEquals(registration, RunProgress.registration(context))
  }

  @Test
  fun aRunInProgressPutsNoDotOnTheAppsIcon() {
    push("r1", "2026-11-22T10:00:20Z")
    val channel = manager.getNotificationChannel(RunProgress.CHANNEL)
    assertEquals("Running work", channel.name)
    assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
    assertFalse(channel.canShowBadge())
  }

  @Test
  fun canBeSweptAwayBeforeAndroid14() {
    push("r1", "2026-11-22T10:00:20Z")
    val flags = shown()["run-progress:r1"]!!.flags
    assertFalse(flags and Notification.FLAG_ONGOING_EVENT != 0)
  }

  @Test
  @Config(sdk = [34])
  fun isOngoingFromAndroid14WhereItCanStillBeSweptAway() {
    push("r1", "2026-11-22T10:00:20Z")
    assertTrue(shown()["run-progress:r1"]!!.flags and Notification.FLAG_ONGOING_EVENT != 0)
  }
}
