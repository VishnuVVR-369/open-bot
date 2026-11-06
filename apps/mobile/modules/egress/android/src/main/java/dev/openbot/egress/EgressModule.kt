package dev.openbot.egress

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import dev.openbot.egress.core.DeviceCredential
import dev.openbot.egress.core.PhoneMode
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class PairOptions : Record {
  @Field val secret: String = ""
  @Field val generation: Int = 0
  @Field val appUrl: String = ""
  @Field val phoneMode: String = "fallback"
}

class RulesOptions : Record {
  @Field val wifiOnly: Boolean = true
  @Field val monthlyCapBytes: Double = 2e9
  @Field val lowBatteryPause: Boolean = true
}

class EgressException(message: String) : CodedException("egress", message, null)

/**
 * The phone connection's JavaScript API. JavaScript pairs and configures it, and reads its
 * status; the credential never comes back, and the service runs without JavaScript.
 */
class EgressModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var listening = false
  private val onChange: () -> Unit = { main.post { if (listening) sendEvent("status", status(context)) } }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw EgressException("The app isn't ready.")

  override fun definition() = ModuleDefinition {
    Name("OpenBotEgress")
    Events("status")

    OnStartObserving {
      listening = true
      Egress.addListener(onChange)
    }
    OnStopObserving {
      listening = false
      Egress.removeListener(onChange)
    }

    Function("deviceId") { CredentialStore.deviceId(context) }

    AsyncFunction("pair") { options: PairOptions ->
      val mode = PhoneMode.fromWire(options.phoneMode) ?: throw EgressException("Unknown phone mode ${options.phoneMode}")
      if (options.secret.isEmpty() || options.generation < 1 || options.appUrl.isEmpty())
        throw EgressException("Incomplete pairing.")
      val ctx = context
      Egress.pair(ctx, Pairing(DeviceCredential(CredentialStore.deviceId(ctx), options.secret, options.generation), options.appUrl), mode)
    }

    /** Stop the service (waiting until it has), and forget the credential. */
    AsyncFunction("forget") { promise: Promise ->
      val ctx = context
      stopService(ctx) {
        Egress.forget(ctx)
        promise.resolve(null)
      }
    }

    AsyncFunction("start") {
      val ctx = context
      if (CredentialStore.read(ctx) == null) throw EgressException("This phone isn't paired.")
      if (!Egress.start(ctx, EgressService.ACTION_USER)) throw EgressException("Android didn't let the app start.")
    }

    AsyncFunction("stop") { Egress.stopAsOwner(context) }

    Function("status") { status(context) }

    AsyncFunction("setPhoneMode") { wire: String ->
      val ctx = context
      val mode = PhoneMode.fromWire(wire) ?: throw EgressException("Unknown phone mode $wire")
      Settings.setPhoneMode(ctx, mode)
      val phase = RunStateStore.read(ctx).phase
      if (mode == PhoneMode.ALWAYS && !Egress.service.running && CredentialStore.read(ctx) != null && phase != RunPhase.STOPPED)
        Egress.start(ctx, EgressService.ACTION_ALWAYS)
      else Egress.refresh(ctx)
    }

    AsyncFunction("setRules") { options: RulesOptions ->
      val ctx = context
      Settings.setRules(ctx, Rules(options.wifiOnly, options.monthlyCapBytes.toLong().coerceAtLeast(0), options.lowBatteryPause))
      Egress.refresh(ctx)
    }

    Function("batteryOptimization") {
      val ctx = context
      val power = ctx.getSystemService(PowerManager::class.java)
      val maker = Build.MANUFACTURER.lowercase()
      mapOf(
        "exempt" to power.isIgnoringBatteryOptimizations(ctx.packageName),
        // MIUI and HyperOS also need autostart allowed, which no API can check.
        "miui" to (maker == "xiaomi" || maker == "redmi" || maker == "poco"),
      )
    }

    AsyncFunction("openBatteryOptimizationSettings") {
      val ctx = context
      val ask =
        Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        ctx.startActivity(ask)
      } catch (_: Exception) {
        ctx.startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    Function("notificationsAllowed") {
      val allowed = Notices.allowed(context)
      mapOf("permission" to allowed.permission, "connection" to allowed.connection, "asking" to allowed.asking)
    }

    Function("lowPowerStandby") {
      val standby = DeviceRules.lowPowerStandby(context)
      mapOf("enabled" to standby.enabled, "exempt" to standby.exempt)
    }

    OnDestroy { Egress.removeListener(onChange) }
  }

  /** Stop the service if it runs, then [done] once it has (or after 5 seconds regardless). */
  private fun stopService(context: Context, done: () -> Unit) {
    if (!Egress.service.running) return done()
    var finished = false
    lateinit var listener: () -> Unit
    fun complete() {
      if (finished) return
      finished = true
      Egress.removeListener(listener)
      done()
    }
    listener = { main.post { if (!Egress.service.running) complete() } }
    Egress.addListener(listener)
    context.stopService(Intent(context, EgressService::class.java))
    main.postDelayed({ complete() }, 5_000)
  }

  private fun status(context: Context): Map<String, Any?> {
    val pairing = CredentialStore.read(context)
    val run = RunStateStore.read(context)
    val service = Egress.service
    val usage = DataUsage.read(context)
    val rules = Settings.rules(context)
    return mapOf(
      "paired" to (pairing != null),
      "generation" to pairing?.credential?.generation,
      "phoneMode" to Settings.phoneMode(context).wire,
      "run" to mapOf("phase" to run.phase.wire, "reason" to run.reason?.wire, "since" to run.since.toDouble()),
      "service" to
        mapOf(
          "running" to service.running,
          "connection" to service.connection?.name?.lowercase(),
          "detail" to service.detail,
          "role" to service.role?.wire,
          "network" to service.network,
          "stats" to
            service.stats?.let {
              mapOf("openStreams" to it.openStreams, "bytesIn" to it.bytesIn.toDouble(), "bytesOut" to it.bytesOut.toDouble())
            },
        ),
      "usage" to
        mapOf(
          "todayBytes" to usage.todayBytes.toDouble(),
          "monthBytes" to usage.monthBytes.toDouble(),
          "monthMeteredBytes" to usage.monthMeteredBytes.toDouble(),
        ),
      "rules" to
        mapOf(
          "wifiOnly" to rules.wifiOnly,
          "monthlyCapBytes" to rules.monthlyCapBytes.toDouble(),
          "lowBatteryPause" to rules.lowBatteryPause,
        ),
    )
  }
}
