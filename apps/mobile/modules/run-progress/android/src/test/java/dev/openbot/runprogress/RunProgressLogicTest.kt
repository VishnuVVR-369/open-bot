package dev.openbot.runprogress

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RunProgressLogicTest {
  private val now = 1_800_000_000_000L

  private fun data(state: String, sentAt: String, extra: Map<String, String> = emptyMap()) =
    mapOf(
      "type" to "run-progress",
      "tag" to "run-progress:r1",
      "runId" to "r1",
      "runState" to state,
      "sentAt" to sentAt,
    ) + (if (state == "ended") emptyMap() else mapOf("title" to "Rex: Book the flight", "body" to "Searching")) + extra

  private fun update(state: String, sentAt: String, extra: Map<String, String> = emptyMap()) =
    ProgressUpdate.parse(data(state, sentAt, extra))!!

  @Test
  fun readsAWorkersMessage() {
    val update =
      update(
        "working",
        "2026-11-22T10:00:20.000Z",
        mapOf(
          "chatId" to "c1",
          "url" to "/chats/c1?run=r1",
          "startedAt" to "2026-11-22T10:00:00.000Z",
          "stepsDone" to "7",
          "stepsTotal" to "3",
        ),
      )
    assertEquals(ProgressState.WORKING, update.state)
    assertEquals(1_795_341_620_000L, update.sentAt)
    assertEquals(1_795_341_600_000L, update.startedAt)
    // More done than there are steps is clamped.
    assertEquals(3, update.stepsDone)
    assertEquals(3, update.stepsTotal)
  }

  @Test
  fun refusesWhatIsntACompleteProgressMessage() {
    assertNull(ProgressUpdate.parse(data("working", "2026-11-22T10:00:20Z") + ("type" to "notification")))
    assertNull(ProgressUpdate.parse(data("paused", "2026-11-22T10:00:20Z")))
    assertNull(ProgressUpdate.parse(data("working", "yesterday")))
    assertNull(ProgressUpdate.parse(data("working", "2026-11-22T10:00:20Z") + ("title" to " ")))
    // The end needs no words.
    assertEquals(ProgressState.ENDED, ProgressUpdate.parse(data("ended", "2026-11-22T10:00:20Z"))!!.state)
    // A link that isn't the app's own route is dropped.
    assertNull(update("working", "2026-11-22T10:00:20Z", mapOf("url" to "https://evil.example")).url)
  }

  @Test
  fun showsUpdatesInOrderAndIgnoresLateOnes() {
    val (first, entry) = ProgressRules.decide(null, update("working", "2026-11-22T10:00:20Z"), null, now)
    assertEquals(Action.SHOW, first)
    val (late, kept) = ProgressRules.decide(entry, update("starting", "2026-11-22T10:00:19Z"), null, now)
    assertEquals(Action.IGNORE, late)
    assertEquals(entry, kept)
    val (again, _) = ProgressRules.decide(entry, update("working", "2026-11-22T10:00:20Z"), null, now)
    assertEquals(Action.IGNORE, again)
    val (next, _) = ProgressRules.decide(entry, update("waiting", "2026-11-22T10:00:35Z"), null, now)
    assertEquals(Action.SHOW, next)
  }

  @Test
  fun anEndedRunNeverComesBack() {
    val (_, shown) = ProgressRules.decide(null, update("working", "2026-11-22T10:00:20Z"), null, now)
    val (removed, ended) = ProgressRules.decide(shown, update("ended", "2026-11-22T10:00:36Z"), null, now)
    assertEquals(Action.REMOVE, removed)
    // A step sent before the end, delivered after it.
    val (late, _) = ProgressRules.decide(ended, update("working", "2026-11-22T10:00:35Z"), null, now)
    assertEquals(Action.IGNORE, late)
    // Even one stamped later: the run is over.
    val (later, _) = ProgressRules.decide(ended, update("working", "2026-11-22T10:01:00Z"), null, now)
    assertEquals(Action.IGNORE, later)
    // The result notification ends it too, before the end message arrives.
    val result = ProgressRules.ended(shown, now)
    assertEquals(Action.IGNORE, ProgressRules.decide(result, update("working", "2026-11-22T10:00:40Z"), null, now).first)
  }

  @Test
  fun aDismissedRunStaysHiddenUntilItEnds() {
    val (_, shown) = ProgressRules.decide(null, update("working", "2026-11-22T10:00:20Z"), null, now)
    val dismissed = ProgressRules.dismissed(shown, now)!!
    val (next, kept) = ProgressRules.decide(dismissed, update("waiting", "2026-11-22T10:00:35Z"), null, now)
    assertEquals(Action.IGNORE, next)
    assertEquals(true, kept!!.dismissed)
    assertEquals(Action.REMOVE, ProgressRules.decide(kept, update("ended", "2026-11-22T10:00:50Z"), null, now).first)
    assertNull(ProgressRules.dismissed(null, now))
  }

  @Test
  fun hidesWhileItsChatIsOnScreen() {
    val chat = mapOf("chatId" to "c1")
    val (hidden, entry) = ProgressRules.decide(null, update("working", "2026-11-22T10:00:20Z", chat), "c1", now)
    assertEquals(Action.HIDE, hidden)
    assertEquals("c1", entry!!.chatId)
    val (shown, _) = ProgressRules.decide(entry, update("working", "2026-11-22T10:00:35Z", chat), "c2", now)
    assertEquals(Action.SHOW, shown)
  }

  @Test
  fun storesEntriesWithTheirLatestUpdateAndForgetsOldOnes() {
    val entry = LedgerEntry(5, ended = false, dismissed = true, chatId = "c1", writtenAt = now)
    assertEquals(entry, LedgerEntry.decode(entry.encode()))
    assertEquals(entry.copy(chatId = null), LedgerEntry.decode(entry.copy(chatId = null).encode()))
    // Text with the separators in it, and every field of an update, come back as they were.
    val latest =
      update(
        "waiting",
        "2026-11-22T10:00:20Z",
        mapOf(
          "title" to "Rex: a=b & c|d%",
          "chatId" to "c1",
          "url" to "/chats/c1?run=r1&x=1",
          "startedAt" to "2026-11-22T10:00:00Z",
          "stepsDone" to "1",
          "stepsTotal" to "3",
        ),
      )
    val withLatest = entry.copy(dismissed = false, latest = latest, latestAt = now)
    assertEquals(withLatest, LedgerEntry.decode(withLatest.encode()))
    assertEquals(latest, ProgressUpdate.parse(latest.toData()))
    assertNull(LedgerEntry.decode("garbage"))
    assertNull(LedgerEntry.decode("5|false|true|0|c1"))
    val entries =
      (0 until ProgressRules.MAX_ENTRIES + 2).associate { "r$it" to entry.copy(writtenAt = now - it) } +
        ("old" to entry.copy(writtenAt = now - ProgressRules.FORGET_AFTER_MS - 1))
    val oldest = "r${ProgressRules.MAX_ENTRIES + 1}"
    assertEquals(setOf("old", "r${ProgressRules.MAX_ENTRIES}", oldest), ProgressRules.forget(entries, now))
  }

  @Test
  fun showsAgainWhatIsLiveWhenItsChatLeavesTheScreen() {
    val chat = mapOf("chatId" to "c1")
    val (hidden, entry) = ProgressRules.decide(null, update("working", "2026-11-22T10:00:20Z", chat), "c1", now)
    assertEquals(Action.HIDE, hidden)
    val entries = mapOf("r1" to entry!!)
    assertEquals(emptyMap<String, Any>(), ProgressRules.showing(entries, "c1", now))
    // What it would have shown, for the time it has left.
    val (latest, left) = ProgressRules.showing(entries, null, now + 60_000)["r1"]!!
    assertEquals("Rex: Book the flight", latest.title)
    assertEquals(ProgressRules.TIMEOUT_MS - 60_000, left)
    assertEquals(setOf("r1"), ProgressRules.showing(entries, "c2", now).keys)
    // The clock was set back since: never longer than a card lasts.
    assertEquals(ProgressRules.TIMEOUT_MS, ProgressRules.showing(entries, null, now - 60 * 60_000)["r1"]!!.second)
    // Not once it would have timed out, ended, or been swiped away.
    assertEquals(emptyMap<String, Any>(), ProgressRules.showing(entries, null, now + ProgressRules.TIMEOUT_MS))
    assertEquals(emptyMap<String, Any>(), ProgressRules.showing(mapOf("r1" to ProgressRules.ended(entry, now)), null, now))
    assertEquals(emptyMap<String, Any>(), ProgressRules.showing(mapOf("r1" to ProgressRules.dismissed(entry, now)!!), null, now))
    val (_, ended) = ProgressRules.decide(entry, update("ended", "2026-11-22T10:00:30Z"), null, now)
    assertEquals(emptyMap<String, Any>(), ProgressRules.showing(mapOf("r1" to ended!!), null, now))
  }

  @Test
  fun isOngoingOnlyWhereItCanBeSweptAway() {
    assertEquals(false, ProgressView.ongoing(29))
    assertEquals(false, ProgressView.ongoing(33))
    assertEquals(true, ProgressView.ongoing(34))
    assertEquals(true, ProgressView.ongoing(36))
  }

  @Test
  fun drawsPlansAsSegmentsAndWaitsWithoutMotion() {
    val plan = ProgressView.of(update("working", "2026-11-22T10:00:20Z", mapOf("stepsDone" to "1", "stepsTotal" to "3", "url" to "/chats/c1?run=r1")))
    assertEquals(ProgressBar(3, 1, false), plan.bar)
    assertEquals("openbot://chats/c1?run=r1", plan.link)
    assertEquals(ProgressView.WORKING, plan.color)
    assertEquals(ProgressBar(1, 0, true), ProgressView.of(update("working", "2026-11-22T10:00:20Z")).bar)
    val waiting = ProgressView.of(update("waiting", "2026-11-22T10:00:20Z"))
    assertNull(waiting.bar)
    assertEquals(ProgressView.ATTENTION, waiting.color)
    assertEquals("openbot://", waiting.link)
  }

  @Test
  fun tellsATimeoutFromASwipe() {
    val expiresAt = now + ProgressRules.TIMEOUT_MS
    assertEquals(false, ProgressRules.timedOut(expiresAt, now))
    assertEquals(false, ProgressRules.timedOut(expiresAt, expiresAt - ProgressRules.TIMEOUT_SLACK_MS - 1))
    assertEquals(true, ProgressRules.timedOut(expiresAt, expiresAt - ProgressRules.TIMEOUT_SLACK_MS))
    assertEquals(true, ProgressRules.timedOut(expiresAt, expiresAt + 60_000))
    // A delete intent from before cards carried their expiry: a swipe.
    assertEquals(false, ProgressRules.timedOut(null, now))
  }
}
