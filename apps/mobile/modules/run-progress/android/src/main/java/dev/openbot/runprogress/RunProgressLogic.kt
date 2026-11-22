package dev.openbot.runprogress

import java.time.Instant

// The rules of a run's progress notification, without Android, so they are unit tested on the JVM.
// `RunProgress` stores and draws what these decide.

/** Where a run is (`RunProgressState` in @open-bot/domain); `ENDED` removes its notification. */
enum class ProgressState(val wire: String) {
  STARTING("starting"),
  WORKING("working"),
  WAITING("waiting"),
  ENDED("ended");

  companion object {
    fun fromWire(value: String?): ProgressState? = entries.firstOrNull { it.wire == value }
  }
}

/** A `run-progress` push (`NativePushData` in @open-bot/domain), read and checked. */
data class ProgressUpdate(
  val runId: String,
  val tag: String,
  val state: ProgressState,
  /** When the worker sent it, in ms: orders a run's messages. */
  val sentAt: Long,
  val title: String,
  val body: String,
  val url: String?,
  val chatId: String?,
  val startedAt: Long?,
  val stepsDone: Int?,
  val stepsTotal: Int?,
) {
  companion object {
    /** Null for anything that isn't a complete `run-progress` message. */
    fun parse(data: Map<String, String>): ProgressUpdate? {
      if (data["type"] != "run-progress") return null
      val runId = data["runId"]?.takeIf { it.isNotBlank() } ?: return null
      val tag = data["tag"]?.takeIf { it.isNotBlank() } ?: return null
      val state = ProgressState.fromWire(data["runState"]) ?: return null
      val sentAt = time(data["sentAt"]) ?: return null
      val title = data["title"].orEmpty()
      // Only the end may come without words: it shows nothing.
      if (state != ProgressState.ENDED && title.isBlank()) return null
      val total = data["stepsTotal"]?.toIntOrNull()?.takeIf { it > 0 }
      return ProgressUpdate(
        runId = runId,
        tag = tag,
        state = state,
        sentAt = sentAt,
        title = title,
        body = data["body"].orEmpty(),
        url = data["url"]?.takeIf { it.startsWith("/") },
        chatId = data["chatId"]?.takeIf { it.isNotBlank() },
        startedAt = time(data["startedAt"]),
        stepsDone = total?.let { data["stepsDone"]?.toIntOrNull()?.coerceIn(0, it) ?: 0 },
        stepsTotal = total,
      )
    }

    private fun time(value: String?): Long? =
      value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
  }
}

/** What the phone remembers about one run's notification, so late or repeated messages lose. */
data class LedgerEntry(
  /** The newest message's `sentAt`. */
  val sentAt: Long,
  /** The run ended: nothing shows it again. */
  val ended: Boolean,
  /** You swiped it away: its updates stay hidden until it ends. */
  val dismissed: Boolean,
  val chatId: String?,
  /** When this phone last wrote it, in ms, to forget old runs. */
  val writtenAt: Long,
) {
  fun encode(): String = listOf(sentAt, ended, dismissed, writtenAt, chatId.orEmpty()).joinToString("|")

  companion object {
    fun decode(value: String?): LedgerEntry? {
      val parts = value?.split("|", limit = 5) ?: return null
      if (parts.size != 5) return null
      return LedgerEntry(
        sentAt = parts[0].toLongOrNull() ?: return null,
        ended = parts[1].toBooleanStrictOrNull() ?: return null,
        dismissed = parts[2].toBooleanStrictOrNull() ?: return null,
        writtenAt = parts[3].toLongOrNull() ?: return null,
        chatId = parts[4].ifEmpty { null },
      )
    }
  }
}

enum class Action {
  /** Post or update the notification. */
  SHOW,
  /** Remove it for good: the run ended. */
  REMOVE,
  /** Remove it for now: you're looking at its chat, where the run shows already. */
  HIDE,
  /** Leave it as it is. */
  IGNORE,
}

object ProgressRules {
  /** Runs this phone forgets about: a run's messages stop long before then. */
  const val FORGET_AFTER_MS = 2 * 24 * 60 * 60 * 1000L
  const val MAX_ENTRIES = 200

  /**
   * What to do with a message, and what to remember after it. An ended run stays ended, and a
   * message older than one already handled changes nothing: FCM doesn't keep a run's messages in
   * order, and a late update must not bring back a notification its run's end removed.
   */
  fun decide(
    entry: LedgerEntry?,
    update: ProgressUpdate,
    visibleChat: String?,
    now: Long,
  ): Pair<Action, LedgerEntry?> {
    if (entry?.ended == true) return Action.IGNORE to entry
    val chatId = update.chatId ?: entry?.chatId
    if (update.state == ProgressState.ENDED)
      return Action.REMOVE to LedgerEntry(maxOf(update.sentAt, entry?.sentAt ?: 0), true, false, chatId, now)
    if (entry != null && update.sentAt <= entry.sentAt) return Action.IGNORE to entry
    val next = LedgerEntry(update.sentAt, false, entry?.dismissed ?: false, chatId, now)
    val action =
      when {
        next.dismissed -> Action.IGNORE
        visibleChat != null && visibleChat == chatId -> Action.HIDE
        else -> Action.SHOW
      }
    return action to next
  }

  /** The run's result arrived first, or it ended some other way: nothing shows it again. */
  fun ended(entry: LedgerEntry?, now: Long): LedgerEntry =
    LedgerEntry(entry?.sentAt ?: 0, true, false, entry?.chatId, now)

  /** You swiped it away. An unknown run has nothing to hide. */
  fun dismissed(entry: LedgerEntry?, now: Long): LedgerEntry? =
    entry?.takeIf { !it.ended }?.copy(dismissed = true, writtenAt = now)

  /** The runs to forget: old ones, and the oldest past `MAX_ENTRIES`. */
  fun forget(entries: Map<String, LedgerEntry>, now: Long): Set<String> {
    val old = entries.filterValues { now - it.writtenAt > FORGET_AFTER_MS }.keys
    val kept = entries.filterKeys { it !in old }.entries.sortedByDescending { it.value.writtenAt }
    return old + kept.drop(MAX_ENTRIES).map { it.key }
  }
}

/** A progress bar: one segment per plan step, or an animated bar while the length is unknown. */
data class ProgressBar(val segments: Int, val done: Int, val indeterminate: Boolean)

/** How a run's notification looks, from its latest update. */
data class ProgressView(
  val title: String,
  val body: String,
  /** Opens the run in its chat. */
  val link: String,
  val startedAt: Long?,
  /** Blue while working, amber while it needs you (the app's `working` and `attention`). */
  val color: Int,
  val bar: ProgressBar?,
) {
  companion object {
    const val WORKING = 0xFF3B74F0.toInt()
    const val ATTENTION = 0xFFF5A524.toInt()

    fun of(update: ProgressUpdate): ProgressView {
      val total = update.stepsTotal
      val bar =
        when {
          total != null -> ProgressBar(total, update.stepsDone ?: 0, false)
          // Waiting on you without a plan: no bar, nothing moves until you answer.
          update.state == ProgressState.WAITING -> null
          else -> ProgressBar(1, 0, true)
        }
      return ProgressView(
        title = update.title,
        body = update.body,
        link = "openbot://${(update.url ?: "/").removePrefix("/")}",
        startedAt = update.startedAt,
        color = if (update.state == ProgressState.WAITING) ATTENTION else WORKING,
        bar = bar,
      )
    }
  }
}
