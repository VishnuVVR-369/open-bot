package dev.openbot.egress.core

import java.math.BigDecimal
import java.math.BigInteger
import org.json.JSONObject
import org.json.JSONTokener

/** The egress mode: whether the computer's traffic goes through your devices. */
enum class EgressMode(val wire: String) {
  OFF("off"),
  PREFER("prefer"),
  REQUIRE("require");

  companion object {
    fun fromWire(value: Any?): EgressMode? = entries.firstOrNull { it.wire == value }
  }
}

/** When the phone carries the computer's traffic: never, while the Mac is offline, or first. */
enum class PhoneMode(val wire: String) {
  OFF("off"),
  FALLBACK("fallback"),
  ALWAYS("always");

  companion object {
    fun fromWire(value: Any?): PhoneMode? = entries.firstOrNull { it.wire == value }
  }
}

/** What the relay wants from this agent: carry new connections, finish the ones it has, or stop. */
enum class AgentRole(val wire: String) {
  ACTIVE("active"),
  STANDBY("standby"),
  RELEASE("release");

  companion object {
    fun fromWire(value: Any?): AgentRole? = entries.firstOrNull { it.wire == value }
  }
}

/** Why the phone can't carry traffic right now. */
enum class UnavailableReason(val wire: String) {
  WIFI_ONLY("wifi-only"),
  DATA_CAP("data-cap"),
  LOW_BATTERY("low-battery"),
  LOW_POWER_STANDBY("low-power-standby"),
  STOPPED("stopped");

  companion object {
    fun fromWire(value: Any?): UnavailableReason? = entries.firstOrNull { it.wire == value }
  }
}

/** JSON control messages, sent as text websocket messages. Mirrors `ControlMessage` in TypeScript. */
sealed interface ControlMessage {
  data class Config(
    val mode: EgressMode,
    val agentOnline: Boolean,
    val wakeable: Boolean? = null,
    val holdMs: Long? = null,
  ) : ControlMessage

  data class Demand(val screenId: String) : ControlMessage

  data object PeerDown : ControlMessage

  data object PeerUp : ControlMessage

  data class Role(val role: AgentRole) : ControlMessage

  data class Policy(val phoneMode: PhoneMode) : ControlMessage

  data class Stats(val openStreams: Long, val bytesIn: Long, val bytesOut: Long) : ControlMessage

  /** [seq] numbers the phone's reports, so one that arrives late can be told apart. */
  data class Unavailable(val reason: UnavailableReason, val seq: Long? = null) : ControlMessage

  /** Once connected: the phone carries traffic again, so its reports up to [seq] are over. */
  data class Available(val seq: Long) : ControlMessage
}

object Control {
  private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

  /**
   * Parse a control message, or null for anything malformed or unknown, so each side can ignore
   * messages from newer versions of the other.
   */
  fun parse(text: String): ControlMessage? {
    val value = parseObject(text) ?: return null
    return when (value.opt("type")) {
      "config" -> {
        val mode = EgressMode.fromWire(value.opt("mode")) ?: return null
        val agentOnline = value.opt("agentOnline") as? Boolean ?: return null
        val wakeable = value.opt("wakeable")
        if (wakeable != null && wakeable !is Boolean) return null
        val holdMs = value.opt("holdMs")
        if (holdMs != null && count(holdMs) == null) return null
        ControlMessage.Config(mode, agentOnline, wakeable as Boolean?, holdMs?.let(::count))
      }
      "demand" -> {
        val screenId = value.opt("screenId") as? String
        if (screenId.isNullOrEmpty()) null else ControlMessage.Demand(screenId)
      }
      "peer-down" -> ControlMessage.PeerDown
      "peer-up" -> ControlMessage.PeerUp
      "role" -> AgentRole.fromWire(value.opt("role"))?.let { ControlMessage.Role(it) }
      "policy" -> PhoneMode.fromWire(value.opt("phoneMode"))?.let { ControlMessage.Policy(it) }
      "stats" -> {
        val openStreams = count(value.opt("openStreams")) ?: return null
        val bytesIn = count(value.opt("bytesIn")) ?: return null
        val bytesOut = count(value.opt("bytesOut")) ?: return null
        ControlMessage.Stats(openStreams, bytesIn, bytesOut)
      }
      "unavailable" -> {
        val reason = UnavailableReason.fromWire(value.opt("reason")) ?: return null
        val seq = value.opt("seq")
        if (seq != null && count(seq) == null) return null
        ControlMessage.Unavailable(reason, seq?.let(::count))
      }
      "available" -> count(value.opt("seq"))?.let { ControlMessage.Available(it) }
      else -> null
    }
  }

  fun encode(message: ControlMessage): String = toJson(message).toString()

  /** The message as JSON, with exactly the fields the TypeScript side writes. */
  fun toJson(message: ControlMessage): JSONObject =
    when (message) {
      is ControlMessage.Config ->
        JSONObject().apply {
          put("type", "config")
          put("mode", message.mode.wire)
          put("agentOnline", message.agentOnline)
          message.wakeable?.let { put("wakeable", it) }
          message.holdMs?.let { put("holdMs", it) }
        }
      is ControlMessage.Demand -> JSONObject().put("type", "demand").put("screenId", message.screenId)
      ControlMessage.PeerDown -> JSONObject().put("type", "peer-down")
      ControlMessage.PeerUp -> JSONObject().put("type", "peer-up")
      is ControlMessage.Role -> JSONObject().put("type", "role").put("role", message.role.wire)
      is ControlMessage.Policy ->
        JSONObject().put("type", "policy").put("phoneMode", message.phoneMode.wire)
      is ControlMessage.Stats ->
        JSONObject()
          .put("type", "stats")
          .put("openStreams", message.openStreams)
          .put("bytesIn", message.bytesIn)
          .put("bytesOut", message.bytesOut)
      is ControlMessage.Unavailable ->
        JSONObject().put("type", "unavailable").put("reason", message.reason.wire).apply {
          message.seq?.let { put("seq", it) }
        }
      is ControlMessage.Available -> JSONObject().put("type", "available").put("seq", message.seq)
    }

  /** A whole JSON object and nothing else, or null. */
  private fun parseObject(text: String): JSONObject? =
    try {
      val tokener = JSONTokener(text)
      val value = tokener.nextValue()
      // Like JSON.parse, nothing may follow the value.
      if (value is JSONObject && tokener.nextClean() == 0.toChar()) value else null
    } catch (_: Exception) {
      null
    }

  /** A JSON number that is a whole, non-negative, safe integer (`Number.isSafeInteger`), or null. */
  private fun count(value: Any?): Long? {
    val whole: Long =
      when (value) {
        is Int -> value.toLong()
        is Long -> value
        is BigInteger -> if (value.bitLength() < 63) value.toLong() else return null
        is BigDecimal ->
          try {
            value.toBigIntegerExact().let { if (it.bitLength() < 63) it.toLong() else return null }
          } catch (_: ArithmeticException) {
            return null
          }
        is Double ->
          if (value.isFinite() && value == Math.floor(value) && Math.abs(value) <= MAX_SAFE_INTEGER) {
            value.toLong()
          } else {
            return null
          }
        is Float -> return count(value.toDouble())
        else -> return null
      }
    return if (whole in 0..MAX_SAFE_INTEGER) whole else null
  }
}
