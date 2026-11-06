package dev.openbot.egress

import android.content.Context
import android.util.Log
import androidx.core.content.ContextCompat
import dev.openbot.egress.core.AgentRole
import dev.openbot.egress.core.AgentStatus
import dev.openbot.egress.core.MuxStats
import dev.openbot.egress.core.PhoneMode
import dev.openbot.egress.core.UnavailableReason
import java.time.Instant
import java.util.concurrent.CopyOnWriteArraySet

/** What the running service is doing right now (not persisted: it is gone with the process). */
data class ServiceStatus(
  val running: Boolean = false,
  val connection: AgentStatus? = null,
  val detail: String? = null,
  val role: AgentRole? = null,
  /** `wifi` or `mobile`, while it relays. */
  val network: String? = null,
  val stats: MuxStats? = null,
)

/** The phone connection's shared logic: wakes, starts, stops and revocation. */
object Egress {
  /** A wake older than this is from an episode that is over (FCM keeps it 30 s, plus clock skew). */
  const val STALE_WAKE_MS = 2 * 60_000L
  /** An ask stays useful longer: FCM keeps it 10 minutes, plus clock skew. */
  const val STALE_ASK_MS = 12 * 60_000L
  /** In `fallback`, after the owner stops it, wakes are ignored this long (the worker's next episode). */
  const val OWNER_STOP_MS = 15 * 60_000L

  @Volatile
  var service = ServiceStatus()
    private set

  private val listeners = CopyOnWriteArraySet<() -> Unit>()

  fun addListener(listener: () -> Unit) = listeners.add(listener)

  fun removeListener(listener: () -> Unit) = listeners.remove(listener)

  internal fun publish(status: ServiceStatus) {
    service = status
    changed()
  }

  /** Something the status shows changed (pairing, run state, rules, usage). */
  fun changed() = listeners.forEach { runCatching { it() } }

  /** An `egress-needed` push (or, in development builds, the same data from adb). */
  fun onEgressNeeded(context: Context, data: Map<String, String>) {
    if (CredentialStore.read(context) == null) return
    val stage = data["stage"]
    val sentAt = data["sentAt"]?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val staleAfter = if (stage == "ask") STALE_ASK_MS else STALE_WAKE_MS
    if (sentAt == null || System.currentTimeMillis() - sentAt > staleAfter) {
      Log.i(TAG, "Ignoring a stale or undated egress push")
      return
    }
    // The server's phone mode, which may have changed while this phone wasn't connected.
    val mode = PhoneMode.fromWire(data["phoneMode"])
    if (mode != null && mode != Settings.phoneMode(context)) {
      Settings.setPhoneMode(context, mode)
      refresh(context)
    }
    when (stage) {
      "wake" -> wake(context)
      "ask" ->
        if (service.connection != AgentStatus.ONLINE)
          Notices.tapToStart(
            context,
            data["title"] ?: "Teammates need your phone's connection",
            data["body"] ?: "Tap to start browsing through this phone.",
          )
    }
  }

  private fun wake(context: Context) {
    val state = RunStateStore.read(context)
    val mode = Settings.phoneMode(context)
    if (state.phase == RunPhase.STOPPED) {
      // In `always`, a stop holds until the owner starts it again; say so again, since the
      // worker only keeps the report for a while.
      if (mode == PhoneMode.ALWAYS) {
        DeviceWork.reportUnavailable(context, UnavailableReason.STOPPED)
        return
      }
      if (System.currentTimeMillis() - state.since < OWNER_STOP_MS) return
    }
    when (mode) {
      PhoneMode.OFF -> return
      PhoneMode.FALLBACK -> {
        // A rule forbids relaying: say why, without starting anything.
        val decision =
          DeviceRules.decide(Settings.rules(context), DeviceRules.snapshot(context), DataUsage.read(context))
        if (decision.reason != null && !service.running) {
          RunStateStore.write(context, RunPhase.PAUSED, decision.reason)
          DeviceWork.reportUnavailable(context, decision.reason)
          changed()
          return
        }
      }
      // In `always` the service starts either way, and pauses itself if a rule applies.
      PhoneMode.ALWAYS -> Unit
    }
    start(context, EgressService.ACTION_WAKE)
  }

  /**
   * Start the service. Android only allows that from the background in some cases (a high
   * priority push, a notification tap, boot); otherwise the owner gets a "Tap to start" notice.
   */
  fun start(context: Context, action: String): Boolean =
    try {
      ContextCompat.startForegroundService(context, EgressService.intent(context, action))
      true
    } catch (error: IllegalStateException) {
      // ForegroundServiceStartNotAllowedException, on Android 12 and later.
      Log.w(TAG, "Android refused to start the phone connection", error)
      Notices.tapToStart(context, "Teammates need your phone's connection", "Tap to start browsing through this phone.")
      false
    }

  /** The owner stopped it, from the app or the notification. */
  fun stopAsOwner(context: Context) {
    if (service.running) {
      context.startService(EgressService.intent(context, EgressService.ACTION_STOP))
      return
    }
    RunStateStore.write(context, RunPhase.STOPPED)
    DeviceWork.reportUnavailable(context, UnavailableReason.STOPPED)
    changed()
  }

  /** Re-check rules and mode in the running service, after the owner changed them. */
  fun refresh(context: Context) {
    if (service.running) context.startService(EgressService.intent(context, EgressService.ACTION_RULES))
    changed()
  }

  /**
   * The server refused this credential (`4401`, or `401` from a device route). Only a refusal of
   * the generation stored now counts: a pairing made meanwhile stays.
   */
  fun revoked(context: Context, generation: Int): Boolean {
    if (!CredentialStore.clear(context, generation)) return false
    RunStateStore.write(context, RunPhase.REVOKED)
    DeviceWork.cancelAll(context)
    if (service.running) context.stopService(EgressService.intent(context, EgressService.ACTION_STOP))
    Notices.turnedOff(context)
    changed()
    return true
  }

  /** Store a new pairing; in `always`, the connection starts right away. */
  fun pair(context: Context, pairing: Pairing, mode: PhoneMode) {
    CredentialStore.write(context, pairing)
    Settings.setPhoneMode(context, mode)
    RunStateStore.write(context, RunPhase.OFF)
    Notices.ensureChannels(context)
    Notices.clearPairing(context)
    if (mode == PhoneMode.ALWAYS) start(context, EgressService.ACTION_ALWAYS)
    changed()
  }

  /** Sign-out, or "Turn off for this phone": forget the pairing without telling the worker anything. */
  fun forget(context: Context) {
    CredentialStore.clear(context)
    RunStateStore.write(context, RunPhase.OFF)
    DeviceWork.cancelAll(context)
    Notices.clearPairing(context)
    changed()
  }
}
