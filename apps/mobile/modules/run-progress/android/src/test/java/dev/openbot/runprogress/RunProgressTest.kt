package dev.openbot.runprogress

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.app.PendingIntent
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
  /** The time since boot, which Android times a card's timeout with; a clock change leaves it. */
  private var elapsed = 5 * 60 * 60 * 1000L
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

  /** The drawn card's own delete intent, which Android sends when that card goes. */
  private fun deleteIntentOf(runId: String): PendingIntent = shown()["run-progress:$runId"]!!.deleteIntent

  /** Android sends the card's delete intent: you swiped it, or it timed out. */
  private fun send(intent: PendingIntent) {
    intent.send()
    ShadowLooper.idleMainLooper()
  }

  @Before
  fun setUp() {
    RunProgress.clock = { now }
    RunProgress.elapsed = { elapsed }
    registration = RunProgress.registration(context, "session-1")
    RunProgress.setVisibleChat(context, null)
  }

  @After
  fun tearDown() {
    RunProgress.setVisibleChat(context, null)
    RunProgress.clock = System::currentTimeMillis
    RunProgress.elapsed = android.os.SystemClock::elapsedRealtime
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
    registration = RunProgress.registration(context, "session-2")
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
    registration = RunProgress.registration(context, "session-2")
    assertTrue(registration != old)
    assertEquals(registration, RunProgress.registration(context, "session-2"))
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
    assertEquals(elapsed + ProgressRules.TIMEOUT_MS, expiry)
    // No keepalive arrived for 30 minutes: Android removes it, and sends its delete intent.
    now += ProgressRules.TIMEOUT_MS
    elapsed = expiry
    manager.cancel("run-progress:r1", 4200)
    deleted("r1", expiry)
    push("r1", "2026-11-22T10:40:20Z")
    assertEquals(setOf("run-progress:r1"), shown().keys)
  }

  @Test
  fun aLateTimeoutLeavesTheUpdateThatCameAfterIt() {
    push("r1", "2026-11-22T10:00:20Z")
    val expiry = expiresAt("r1")
    now += ProgressRules.TIMEOUT_MS
    elapsed = expiry
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
    assertEquals(registration, RunProgress.registration(context, "session-1"))
  }

  @Test
  fun anOldCardsTimeoutAfterARepostIsNoSwipe() {
    push("r1", "2026-11-22T10:00:20Z")
    val first = deleteIntentOf("r1")
    val firstExpiry = expiresAt("r1")
    // A keepalive replaces the card just before it would time out.
    now += ProgressRules.TIMEOUT_MS - 10_000
    elapsed += ProgressRules.TIMEOUT_MS - 10_000
    push("r1", "2026-11-22T10:30:10Z")
    assertTrue(expiresAt("r1") > firstExpiry)
    // The first card's own timeout still fires (it raced the repost): it says when that card
    // expired, not the new one, so it's the timeout and records no swipe.
    now += 10_000
    elapsed = firstExpiry
    assertEquals(firstExpiry, shadowOf(first).savedIntent.getLongExtra(RunProgress.EXTRA_EXPIRES_AT, -1))
    send(first)
    assertEquals(setOf("run-progress:r1"), shown().keys)
    push("r1", "2026-11-22T10:30:25Z")
    assertEquals(setOf("run-progress:r1"), shown().keys)
    // The new card's swipe still counts.
    send(deleteIntentOf("r1"))
    push("r1", "2026-11-22T10:30:40Z")
    assertEquals(emptySet<String>(), shown().keys)
  }

  @Test
  fun aClockChangeNeitherMakesASwipeATimeoutNorATimeoutASwipe() {
    push("swiped", "2026-11-22T10:00:20Z")
    push("timedOut", "2026-11-22T10:00:20Z", chatId = "c2")
    val timeout = deleteIntentOf("timedOut")
    // The clock is set two hours on; a minute later you swipe the first card away.
    now += 2 * 60 * 60 * 1000L
    elapsed += 60_000
    send(deleteIntentOf("swiped"))
    push("swiped", "2026-11-22T12:01:35Z")
    assertEquals(setOf("run-progress:timedOut"), shown().keys)
    // The clock is set back four hours; the second card times out when its 30 minutes are up.
    now -= 4 * 60 * 60 * 1000L
    elapsed += ProgressRules.TIMEOUT_MS - 60_000
    manager.cancel("run-progress:timedOut", 4200)
    send(timeout)
    push("timedOut", "2026-11-22T12:31:35Z", chatId = "c2")
    assertEquals(setOf("run-progress:timedOut"), shown().keys)
  }

  @Test
  fun aNewSessionNeverUsesTheRegistrationOfTheOneBefore() {
    assertTrue(RunProgress.signedIn(context))
    val first = registration
    push("r1", "2026-11-22T10:00:20Z")
    // The app starts again on the same session: the same registration, and its card stays.
    assertEquals(first, RunProgress.registration(context, "session-1"))
    assertEquals(setOf("run-progress:r1"), shown().keys)
    // Another session, though the phone never saw the first one end: a new registration, and
    // nothing of the sign-in before, drawn or kept.
    registration = RunProgress.registration(context, "session-2")
    assertTrue(registration != first)
    assertEquals(emptySet<String>(), shown().keys)
    assertEquals(setOf("@registration", "@session"), ledger.all.keys)
    assertFalse("session-2" in ledger.all.values.map { it.toString() })
    RunProgress.setVisibleChat(context, null)
    assertEquals(emptySet<String>(), shown().keys)
    push("r2", "2026-11-22T10:00:35Z", registration = first)
    assertEquals(emptySet<String>(), shown().keys)
    push("r3", "2026-11-22T10:00:35Z")
    assertEquals(setOf("run-progress:r3"), shown().keys)
    // Signed out: no sign-in left.
    RunProgress.reset(context)
    assertFalse(RunProgress.signedIn(context))
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
