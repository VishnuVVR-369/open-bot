package dev.openbot.egress

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.content.ContextCompat
import dev.openbot.egress.core.Egress
import dev.openbot.egress.core.Nat64Prefix
import dev.openbot.egress.core.UnavailableReason
import java.net.InetAddress
import javax.net.SocketFactory

/** The phone's state, as far as the rules care. */
data class Conditions(
  /** A usable unmetered network (Wi-Fi, Ethernet), if there is one. */
  val unmetered: Network?,
  /** The system's default network, if any, and whether it is metered. */
  val default: Network?,
  val defaultMetered: Boolean,
  val batteryPercent: Int,
  val charging: Boolean,
  /** Low Power Standby is on, applies to this app, and the screen is off. */
  val lowPowerStandby: Boolean,
)

/** What the rules allow: why not, or which network to use. */
data class Decision(val reason: UnavailableReason?, val network: Network?, val metered: Boolean, val batteryLow: Boolean)

object DeviceRules {
  const val LOW_BATTERY = 20
  const val BATTERY_RECOVERED = 25

  /**
   * Decide from [conditions]. [wasBatteryLow] gives the battery rule its hysteresis: it pauses
   * below 20% and resumes above 25% or once charging.
   */
  fun decide(rules: Rules, conditions: Conditions, usage: Usage, wasBatteryLow: Boolean = false): Decision {
    val batteryLow =
      rules.lowBatteryPause &&
        !conditions.charging &&
        if (wasBatteryLow) conditions.batteryPercent <= BATTERY_RECOVERED else conditions.batteryPercent < LOW_BATTERY
    val network = if (rules.wifiOnly) conditions.unmetered else conditions.default
    val metered = !rules.wifiOnly && conditions.defaultMetered
    val reason =
      when {
        rules.wifiOnly && conditions.unmetered == null -> UnavailableReason.WIFI_ONLY
        metered && rules.monthlyCapBytes > 0 && usage.monthMeteredBytes >= rules.monthlyCapBytes ->
          UnavailableReason.DATA_CAP
        batteryLow -> UnavailableReason.LOW_BATTERY
        conditions.lowPowerStandby -> UnavailableReason.LOW_POWER_STANDBY
        else -> null
      }
    return Decision(reason, network, metered, batteryLow)
  }

  /** The conditions right now, without watching, for a wake message. */
  @Suppress("DEPRECATION")
  fun snapshot(context: Context): Conditions {
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val unmetered =
      connectivity.allNetworks
        .mapNotNull { network -> connectivity.getNetworkCapabilities(network)?.let { network to it } }
        .filter { (_, caps) -> caps.isUsable() && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) }
        .maxByOrNull { (_, caps) -> caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) }
        ?.first
    val default = connectivity.activeNetwork
    val defaultCaps = default?.let { connectivity.getNetworkCapabilities(it) }
    return withDevice(
      context,
      unmetered,
      default.takeIf { defaultCaps?.isUsable() == true },
      defaultCaps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true,
    )
  }

  internal fun withDevice(context: Context, unmetered: Network?, default: Network?, defaultMetered: Boolean): Conditions {
    val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
    val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
    return Conditions(
      unmetered = unmetered,
      default = default,
      defaultMetered = defaultMetered,
      batteryPercent = if (level < 0 || scale <= 0) 100 else level * 100 / scale,
      charging = plugged,
      lowPowerStandby = lowPowerStandby(context).applies && !context.getSystemService(PowerManager::class.java).isInteractive,
    )
  }

  data class LowPowerStandby(val enabled: Boolean, val exempt: Boolean) {
    val applies get() = enabled && !exempt
  }

  /** Android 13's Low Power Standby, which can cut networking even for foreground services. */
  fun lowPowerStandby(context: Context): LowPowerStandby {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return LowPowerStandby(false, false)
    val power = context.getSystemService(PowerManager::class.java)
    val exempt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && power.isExemptFromLowPowerStandby
    return LowPowerStandby(power.isLowPowerStandbyEnabled, exempt)
  }

  internal fun NetworkCapabilities.isUsable() =
    hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
      hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED)
}

/**
 * Watches everything the rules look at, and calls [onChange] on the main thread when any of it
 * changes. Unmetered networks are tracked from callbacks, so a Wi-Fi network is known even when
 * mobile data is the default.
 */
class RuleWatcher(private val context: Context, private val onChange: () -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val unmetered = LinkedHashMap<Network, NetworkCapabilities>()
  private var default: Network? = null
  private var defaultCaps: NetworkCapabilities? = null
  private var started = false

  private fun changed() {
    main.post { if (started) onChange() }
  }

  private val unmeteredCallback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        synchronized(unmetered) { unmetered[network] = caps }
        changed()
      }

      override fun onLost(network: Network) {
        synchronized(unmetered) { unmetered.remove(network) }
        changed()
      }
    }

  private val defaultCallback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        synchronized(unmetered) {
          default = network
          defaultCaps = caps
        }
        changed()
      }

      override fun onLost(network: Network) {
        synchronized(unmetered) {
          if (default == network) {
            default = null
            defaultCaps = null
          }
        }
        changed()
      }
    }

  private val receiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) = changed()
    }

  @Suppress("DEPRECATION") // allNetworks, only to seed what the callbacks then keep current.
  fun start() {
    if (started) return
    started = true
    // The callbacks report the networks that exist only later, while the first decision is made
    // now: without this, a phone on Wi-Fi would first look like it isn't.
    synchronized(unmetered) {
      for (network in connectivity.allNetworks) {
        val caps = connectivity.getNetworkCapabilities(network) ?: continue
        if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
          unmetered[network] = caps
      }
      default = connectivity.activeNetwork
      defaultCaps = default?.let { connectivity.getNetworkCapabilities(it) }
    }
    connectivity.registerNetworkCallback(
      NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        .build(),
      unmeteredCallback,
    )
    connectivity.registerDefaultNetworkCallback(defaultCallback)
    val filter =
      IntentFilter().apply {
        addAction(Intent.ACTION_BATTERY_CHANGED)
        addAction(Intent.ACTION_POWER_CONNECTED)
        addAction(Intent.ACTION_POWER_DISCONNECTED)
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
          addAction(PowerManager.ACTION_LOW_POWER_STANDBY_ENABLED_CHANGED)
      }
    ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  fun stop() {
    if (!started) return
    started = false
    runCatching { connectivity.unregisterNetworkCallback(unmeteredCallback) }
    runCatching { connectivity.unregisterNetworkCallback(defaultCallback) }
    runCatching { context.unregisterReceiver(receiver) }
  }

  fun conditions(): Conditions {
    val (bestUnmetered, current, currentCaps) =
      synchronized(unmetered) {
        Triple(
          unmetered.entries
            .filter { (_, caps) -> with(DeviceRules) { caps.isUsable() } }
            .maxByOrNull { (_, caps) -> caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) }
            ?.key,
          default,
          defaultCaps,
        )
      }
    return DeviceRules.withDevice(
      context,
      bestUnmetered,
      current.takeIf { currentCaps != null && with(DeviceRules) { currentCaps.isUsable() } },
      currentCaps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true,
    )
  }
}

/** Destination connections bound to one network, so Wi-Fi only can never fall back to mobile data. */
class NetworkEgress(private val connectivity: ConnectivityManager, private val network: Network) : Egress {
  override val socketFactory: SocketFactory = network.socketFactory

  override fun lookup(host: String): List<InetAddress> = network.getAllByName(host).toList()

  override val nat64: List<Nat64Prefix>
    get() = nat64Of(connectivity.getLinkProperties(network))

  companion object {
    fun nat64Of(properties: LinkProperties?): List<Nat64Prefix> {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
      val prefix = properties?.nat64Prefix ?: return emptyList()
      return listOfNotNull(
        runCatching { Nat64Prefix(prefix.address.hostAddress ?: return emptyList(), prefix.prefixLength) }.getOrNull()
      )
    }
  }
}
