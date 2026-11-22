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
import org.robolectric.annotation.Config
import java.time.Instant

/** The notification itself, drawn and removed through Android's notification manager. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RunProgressTest {
  private val context: Context = ApplicationProvider.getApplicationContext<Application>()
  private val manager = context.getSystemService(NotificationManager::class.java)
  private var now = Instant.parse("2026-11-22T10:00:20Z").toEpochMilli()

  private fun push(runId: String, sentAt: String, state: String = "working", chatId: String = "c1") =
    RunProgress.onPush(
      context,
      buildMap {
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

  @Before
  fun setUp() {
    RunProgress.clock = { now }
    RunProgress.setVisibleChat(context, null)
  }

  @After
  fun tearDown() {
    RunProgress.setVisibleChat(context, null)
    RunProgress.clock = System::currentTimeMillis
    manager.cancelAll()
    context.getSharedPreferences("openbot_run_progress", Context.MODE_PRIVATE).edit().clear().commit()
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
    context.sendBroadcast(
      Intent(context, RunProgressDismissReceiver::class.java)
        .setAction(RunProgress.ACTION_DISMISSED)
        .putExtra("runId", "r1"),
    )
    org.robolectric.shadows.ShadowLooper.idleMainLooper()
    assertEquals(emptySet<String>(), shown().keys)
    // Later updates stay hidden, even when its chat leaves the screen.
    push("r1", "2026-11-22T10:00:50Z")
    RunProgress.setVisibleChat(context, "c9")
    assertEquals(emptySet<String>(), shown().keys)
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
