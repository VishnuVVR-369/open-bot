package dev.openbot.egress

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import dev.openbot.egress.core.DeviceCredential
import dev.openbot.egress.core.PhoneMode
import dev.openbot.egress.core.UnavailableReason
import java.security.KeyStore
import java.time.LocalDate
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal const val TAG = "OpenBotEgress"

/**
 * Everything the phone connection keeps, in one preferences file that backups exclude (see
 * `res/xml/openbot_*_rules.xml`): a restored device id or credential would belong to another phone.
 * Writes that must survive process death use `commit()`.
 */
internal object Prefs {
  const val NAME = "openbot_egress"

  fun of(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)
}

/** A paired phone's credential, and the open-bot it belongs to. */
data class Pairing(val credential: DeviceCredential, val appUrl: String)

/**
 * The device credential, encrypted with an AES-GCM key that never leaves the Android Keystore.
 * JavaScript hands it over once, when pairing, and can never read it back.
 */
object CredentialStore {
  private const val KEY_ALIAS = "openbot_egress_credential"
  private const val CREDENTIAL = "credential"
  private const val DEVICE_ID = "device_id"

  /** This install's device id: made once, kept across sign-outs and pairings. */
  @Synchronized
  fun deviceId(context: Context): String {
    val prefs = Prefs.of(context)
    prefs.getString(DEVICE_ID, null)?.let {
      return it
    }
    val id = UUID.randomUUID().toString()
    prefs.edit().putString(DEVICE_ID, id).commit()
    return id
  }

  @Synchronized
  fun read(context: Context): Pairing? {
    val prefs = Prefs.of(context)
    val stored = prefs.getString(CREDENTIAL, null) ?: return null
    return try {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
      val json = JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
      Pairing(
        DeviceCredential(json.getString("deviceId"), json.getString("secret"), json.getInt("generation")),
        json.getString("appUrl"),
      )
    } catch (error: Exception) {
      // The key is gone (a restore, or the owner cleared credentials): the pairing is unusable.
      Log.w(TAG, "Dropping a credential that can't be decrypted", error)
      prefs.edit().remove(CREDENTIAL).commit()
      null
    }
  }

  @Synchronized
  fun write(context: Context, pairing: Pairing) {
    val json =
      JSONObject()
        .put("deviceId", pairing.credential.deviceId)
        .put("secret", pairing.credential.secret)
        .put("generation", pairing.credential.generation)
        .put("appUrl", pairing.appUrl)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
    Prefs.of(context).edit().putString(CREDENTIAL, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
  }

  /**
   * Forget the credential. With [generation], only that one: a refusal answering an old
   * credential must not erase a pairing made meanwhile. Returns whether it was forgotten.
   */
  @Synchronized
  fun clear(context: Context, generation: Int? = null): Boolean {
    if (generation != null && read(context)?.credential?.generation != generation) return false
    Prefs.of(context).edit().remove(CREDENTIAL).commit()
    return true
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let {
      return it
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }
}

/** What the phone connection is doing, persisted so a restart after process death knows. */
enum class RunPhase(val wire: String) {
  /** Not running, and nothing stops a wake from starting it. */
  OFF("off"),
  RUNNING("running"),
  /** A rule forbids relaying ([RunState.reason] says which). */
  PAUSED("paused"),
  /** The owner stopped it. */
  STOPPED("stopped"),
  /** The relay no longer needed it. */
  RELEASED("released"),
  /** The pairing was turned off; the credential is gone. */
  REVOKED("revoked"),
}

data class RunState(val phase: RunPhase, val since: Long, val reason: UnavailableReason? = null)

object RunStateStore {
  @Synchronized
  fun read(context: Context): RunState {
    val prefs = Prefs.of(context)
    val phase = RunPhase.entries.firstOrNull { it.wire == prefs.getString("run_phase", null) } ?: RunPhase.OFF
    return RunState(phase, prefs.getLong("run_since", 0), UnavailableReason.fromWire(prefs.getString("run_reason", null)))
  }

  @Synchronized
  fun write(context: Context, phase: RunPhase, reason: UnavailableReason? = null) {
    Prefs.of(context)
      .edit()
      .putString("run_phase", phase.wire)
      .putLong("run_since", System.currentTimeMillis())
      .putString("run_reason", reason?.wire)
      .commit()
  }
}

/** The owner's rules for when this phone may carry traffic. */
data class Rules(
  /** Only on an unmetered network, so traffic never moves to mobile data. */
  val wifiOnly: Boolean = true,
  /** Mobile data per calendar month; 0 for no limit. */
  val monthlyCapBytes: Long = 2L * 1000 * 1000 * 1000,
  /** Pause below 20% battery while not charging. */
  val lowBatteryPause: Boolean = true,
)

/**
 * Numbers the phone's unavailable reports. Each connection tells the worker the latest number,
 * so a report that arrives after it (one already on its way through the device route) can be
 * told apart from a new one.
 */
object ReportSeq {
  @Synchronized
  fun next(context: Context): Long {
    val prefs = Prefs.of(context)
    val next = prefs.getLong("report_seq", 0) + 1
    prefs.edit().putLong("report_seq", next).commit()
    return next
  }

  fun last(context: Context): Long = Prefs.of(context).getLong("report_seq", 0)

  /** A connection told the worker reports up to [seq] are over. */
  @Synchronized
  fun acknowledge(context: Context, seq: Long) {
    val prefs = Prefs.of(context)
    if (seq > prefs.getLong("report_acked", 0)) prefs.edit().putLong("report_acked", seq).commit()
  }

  /** Whether a connection has said report [seq] is over, so sending it now would only mislead. */
  fun acknowledged(context: Context, seq: Long): Boolean = seq <= Prefs.of(context).getLong("report_acked", 0)
}

object Settings {
  fun phoneMode(context: Context): PhoneMode =
    PhoneMode.fromWire(Prefs.of(context).getString("phone_mode", null)) ?: PhoneMode.FALLBACK

  fun setPhoneMode(context: Context, mode: PhoneMode) {
    Prefs.of(context).edit().putString("phone_mode", mode.wire).commit()
  }

  fun rules(context: Context): Rules {
    val prefs = Prefs.of(context)
    val defaults = Rules()
    return Rules(
      wifiOnly = prefs.getBoolean("rule_wifi_only", defaults.wifiOnly),
      monthlyCapBytes = prefs.getLong("rule_cap_bytes", defaults.monthlyCapBytes),
      lowBatteryPause = prefs.getBoolean("rule_low_battery", defaults.lowBatteryPause),
    )
  }

  fun setRules(context: Context, rules: Rules) {
    Prefs.of(context)
      .edit()
      .putBoolean("rule_wifi_only", rules.wifiOnly)
      .putLong("rule_cap_bytes", rules.monthlyCapBytes)
      .putBoolean("rule_low_battery", rules.lowBatteryPause)
      .commit()
  }

  /** The newest FCM token, for the coalesced push-token job. */
  fun pushToken(context: Context): String? = Prefs.of(context).getString("push_token", null)

  fun setPushToken(context: Context, token: String) {
    Prefs.of(context).edit().putString("push_token", token).commit()
  }
}

data class Usage(val todayBytes: Long, val monthBytes: Long, val monthMeteredBytes: Long)

/**
 * Bytes this phone carried for teammates, per local day and month. Mobile data is counted
 * separately, for the cap. Both legs count (the tunnel and the destination), since both use data.
 */
object DataUsage {
  @Synchronized
  fun add(context: Context, bytes: Long, metered: Boolean) {
    if (bytes <= 0) return
    val current = rolled(context)
    Prefs.of(context)
      .edit()
      .putString("usage_day", LocalDate.now().toString())
      .putString("usage_month", month())
      .putLong("usage_today", current.todayBytes + bytes)
      .putLong("usage_month_all", current.monthBytes + bytes)
      .putLong("usage_month_metered", current.monthMeteredBytes + if (metered) bytes else 0)
      .apply()
  }

  @Synchronized fun read(context: Context): Usage = rolled(context)

  /** The local month the monthly counters (and the cap) count, like `2026-11`. */
  fun month() = LocalDate.now().let { "%04d-%02d".format(it.year, it.monthValue) }

  /** The counters, starting over on a new local day or month. */
  private fun rolled(context: Context): Usage {
    val prefs = Prefs.of(context)
    val sameDay = prefs.getString("usage_day", null) == LocalDate.now().toString()
    val sameMonth = prefs.getString("usage_month", null) == month()
    return Usage(
      todayBytes = if (sameDay) prefs.getLong("usage_today", 0) else 0,
      monthBytes = if (sameMonth) prefs.getLong("usage_month_all", 0) else 0,
      monthMeteredBytes = if (sameMonth) prefs.getLong("usage_month_metered", 0) else 0,
    )
  }
}
