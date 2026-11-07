package dev.openbot.egress

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ServiceCompat
import dev.openbot.egress.core.AgentListener
import dev.openbot.egress.core.AgentRole
import dev.openbot.egress.core.AgentStatus
import dev.openbot.egress.core.Egress as CoreEgress
import dev.openbot.egress.core.EgressAgent
import dev.openbot.egress.core.PhoneMode
import dev.openbot.egress.core.TcpConnector
import dev.openbot.egress.core.TrafficMeter
import dev.openbot.egress.core.UnavailableReason
import dev.openbot.egress.core.asScheduler
import dev.openbot.egress.core.newIoPool
import dev.openbot.egress.core.shutdownWhenIdle
import java.util.concurrent.ExecutorService
import java.util.concurrent.ScheduledExecutorService
import java.net.InetAddress
import okhttp3.Dns
import okhttp3.OkHttpClient

/**
 * The phone connection: a `specialUse` foreground service that runs the egress agent while the
 * owner's rules allow it, without React Native. A wake push, the boot receiver or the app's own
 * controls start it; it stops when the rules no longer allow it or the agent goes idle. The
 * module's overview is the "Phone connection" section of apps/mobile/README.md.
 *
 * Everything here runs on the main thread; the agent has its own.
 */
class EgressService : Service() {
  companion object {
    /** A wake push. */
    const val ACTION_WAKE = "dev.openbot.egress.WAKE"
    /** The owner started it (the app, or "Tap to start"). */
    const val ACTION_USER = "dev.openbot.egress.USER"
    /** Boot, or the phone mode became `always`. */
    const val ACTION_ALWAYS = "dev.openbot.egress.ALWAYS"
    /** The owner stopped it. */
    const val ACTION_STOP = "dev.openbot.egress.STOP"
    /** The owner changed a rule or the phone mode: check again. */
    const val ACTION_RULES = "dev.openbot.egress.RULES"

    fun intent(context: Context, action: String): Intent =
      Intent(context, EgressService::class.java).setAction(action)

    /** In `fallback`, the service gives up after this long without the relay. */
    const val FALLBACK_GIVE_UP_MS = 10 * 60_000L
    private const val NOTIFICATION_EVERY_MS = 10_000L
    private const val USAGE_EVERY_MS = 2_000L
  }

  private val main = Handler(Looper.getMainLooper())
  private val meter = TrafficMeter()
  private val baseClient by lazy { OkHttpClient() }
  private lateinit var watcher: RuleWatcher

  private var running = false
  private var pairing: Pairing? = null
  private var agent: EgressAgent? = null
  private var agentNetwork: Network? = null
  private var agentThreads: Pair<ScheduledExecutorService, ExecutorService>? = null
  private var decision: Decision? = null
  private var batteryLow = false
  private var connection: AgentStatus? = null
  private var detail: String? = null
  private var role: AgentRole? = null
  /** The pause reason already reported, so each pause is reported once. */
  private var reported: UnavailableReason? = null
  /** Paused at the data cap: the month it was reached in, since a new month lifts it. */
  private var cappedIn: String? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var lastNotified = 0L
  private var notificationQueued = false

  private val giveUp = Runnable {
    Log.i(TAG, "No relay for 10 minutes in fallback: stopping")
    RunStateStore.write(this, RunPhase.OFF)
    finish()
  }
  private var giveUpScheduled = false

  private val usageTick =
    object : Runnable {
      override fun run() {
        val bytes = meter.take()
        if (bytes > 0) {
          DataUsage.add(this@EgressService, bytes, decision?.metered == true)
          // Reaching the cap is a rule like any other.
          if (decision?.metered == true) evaluate()
          updateNotification()
          publish()
        } else if (cappedIn != null && cappedIn != DataUsage.month()) {
          evaluate() // A new month: nothing else would notice while no traffic flows.
        }
        if (running) main.postDelayed(this, USAGE_EVERY_MS)
      }
    }

  override fun onCreate() {
    super.onCreate()
    watcher = RuleWatcher(this) { evaluate() }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // First, always: Android ends an app that doesn't call this soon after starting the service.
    goForeground("Starting the phone connection", null)
    handle(intent?.action)
    return START_STICKY
  }

  private fun handle(action: String?) {
    val stored = CredentialStore.read(this)
    if (stored == null) {
      finish()
      return
    }
    if (pairing != null && pairing != stored) stopAgent(null) // Paired again meanwhile.
    pairing = stored
    val state = RunStateStore.read(this)
    val mode = Settings.phoneMode(this)
    val proceed =
      when (action) {
        ACTION_STOP -> {
          RunStateStore.write(this, RunPhase.STOPPED)
          report(UnavailableReason.STOPPED)
          finish()
          return
        }
        ACTION_USER -> {
          Notices.clearTapToStart(this)
          true
        }
        ACTION_WAKE -> mode != PhoneMode.OFF
        ACTION_ALWAYS -> mode == PhoneMode.ALWAYS && state.phase != RunPhase.STOPPED && state.phase != RunPhase.REVOKED
        ACTION_RULES -> running || resumable(state, mode)
        // A sticky restart after the process died: carry on only from where that makes sense.
        else -> resumable(state, mode)
      }
    if (!proceed) {
      if (!running) finish()
      return
    }
    if (!running) {
      running = true
      watcher.start()
      main.postDelayed(usageTick, USAGE_EVERY_MS)
    }
    evaluate()
  }

  private fun resumable(state: RunState, mode: PhoneMode) =
    state.phase == RunPhase.RUNNING || (state.phase == RunPhase.PAUSED && mode == PhoneMode.ALWAYS)

  /** Apply the rules and the phone mode to what is running. */
  private fun evaluate() {
    if (!running) return
    val mode = Settings.phoneMode(this)
    if (mode == PhoneMode.OFF) {
      RunStateStore.write(this, RunPhase.OFF)
      finish()
      return
    }
    val next = DeviceRules.decide(Settings.rules(this), watcher.conditions(), DataUsage.read(this), batteryLow)
    batteryLow = next.batteryLow
    decision = next
    val reason = next.reason
    cappedIn = if (reason == UnavailableReason.DATA_CAP) DataUsage.month() else null
    if (reason != null) {
      val first = reported != reason
      reported = reason
      val hadAgent = agent != null
      // Each pause is reported once: over the tunnel while it is open, else the device route.
      stopAgent(if (first) reason else null)
      releaseLocks()
      if (first) {
        if (!hadAgent) report(reason)
        Notices.paused(this, reason)
      }
      RunStateStore.write(this, RunPhase.PAUSED, reason)
      if (mode == PhoneMode.FALLBACK) {
        finish()
        return
      }
      // `always`: stay, watch the rule, and resume on our own.
      cancelGiveUp()
      updateNotification(force = true)
      publish()
      Egress.changed()
      return
    }
    reported = null
    // Also a notice an earlier run of the service left.
    Notices.clearPaused(this)
    if (RunStateStore.read(this).phase != RunPhase.RUNNING) {
      RunStateStore.write(this, RunPhase.RUNNING)
      Egress.changed()
    }
    holdLocks(next)
    if (agent == null || agentNetwork != next.network) startAgent(next.network)
    else if (connection == AgentStatus.OFFLINE) agent?.retryNow() // A usable network may be back.
    updateGiveUp(mode)
    updateNotification()
    publish()
  }

  private fun startAgent(network: Network?) {
    stopAgent(null)
    val current = pairing ?: return
    val executor = EgressAgent.newExecutor()
    val io = newIoPool()
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val connector =
      TcpConnector(
        executor,
        io,
        { network?.let { NetworkEgress(connectivity, it) } ?: CoreEgress.DEFAULT },
        meter,
        executor.asScheduler(),
      )
    val client = {
      network?.let { bound ->
        baseClient
          .newBuilder()
          .socketFactory(bound.socketFactory)
          .dns(
            object : Dns {
              override fun lookup(hostname: String): List<InetAddress> = bound.getAllByName(hostname).toList()
            }
          )
          .build()
      } ?: baseClient
    }
    // Every report so far: a pause later stops this agent, so its report is always newer.
    val covers = ReportSeq.last(this)
    lateinit var created: EgressAgent
    val listener =
      object : AgentListener {
        // Called on the agent's thread; everything else here runs on the main thread.
        private fun onMain(block: () -> Unit) {
          main.post { if (agent === created) block() }
        }

        override fun onStatus(status: AgentStatus, detail: String?) = onMain {
          connection = status
          this@EgressService.detail = detail
          if (status == AgentStatus.ONLINE) {
            Notices.clearTapToStart(this@EgressService)
            // A pause report still waiting for a network would arrive after this connection and
            // have the worker think the phone can't help.
            ReportSeq.acknowledge(this@EgressService, covers)
            DeviceWork.cancelUnavailable(this@EgressService)
          }
          updateGiveUp(Settings.phoneMode(this@EgressService))
          updateNotification(force = status == AgentStatus.ONLINE)
          publish()
        }

        override fun onRole(role: AgentRole) = onMain {
          this@EgressService.role = role
          if (role == AgentRole.RELEASE) {
            RunStateStore.write(this@EgressService, RunPhase.RELEASED)
            finish()
          } else {
            updateNotification(force = true)
            publish()
          }
        }

        override fun onPolicy(mode: PhoneMode) = onMain {
          if (mode == Settings.phoneMode(this@EgressService)) return@onMain
          Settings.setPhoneMode(this@EgressService, mode)
          evaluate()
          Egress.changed()
        }

        override fun onRevoked(generation: Int) = onMain {
          if (!Egress.revoked(this@EgressService, generation)) {
            // The refusal answered an older pairing: carry on with the current one.
            pairing = CredentialStore.read(this@EgressService)
            stopAgent(null)
            evaluate()
          } else finish()
        }
      }
    created =
      EgressAgent(
        appUrl = current.appUrl,
        credential = current.credential,
        client = client,
        connector = connector,
        executor = executor,
        listener = listener,
        meter = meter,
        log = { Log.i(TAG, it) },
        lastReport = covers,
      )
    agent = created
    agentNetwork = network
    agentThreads = executor to io
    connection = AgentStatus.CONNECTING
    created.start()
  }

  /** Stop the agent, telling the relay why first if a rule is the reason. */
  private fun stopAgent(reason: UnavailableReason?) {
    val current = agent ?: return
    agent = null
    agentNetwork = null
    connection = null
    detail = null
    role = null
    if (reason != null) {
      // Over the tunnel if it is open (at once), otherwise through the device route.
      val seq = ReportSeq.next(this)
      current.reportUnavailable(reason, seq) { sent -> if (!sent) main.post { report(reason, seq) } }
    }
    current.stop(if (reason != null) Notices.reasonText(reason) else "Agent stopped")
    agentThreads?.let { (executor, io) ->
      // After the report and the stop just queued; the stop destroys the sockets the IO threads read.
      executor.shutdownWhenIdle()
      io.shutdown()
    }
    agentThreads = null
  }

  private fun report(reason: UnavailableReason, seq: Long = ReportSeq.next(this)) =
    DeviceWork.reportUnavailable(this, reason, seq)

  private fun updateGiveUp(mode: PhoneMode) {
    val waiting = mode == PhoneMode.FALLBACK && connection != AgentStatus.ONLINE
    if (waiting && !giveUpScheduled) {
      giveUpScheduled = true
      main.postDelayed(giveUp, FALLBACK_GIVE_UP_MS)
    } else if (!waiting) cancelGiveUp()
  }

  private fun cancelGiveUp() {
    giveUpScheduled = false
    main.removeCallbacks(giveUp)
  }

  @SuppressLint("WakelockTimeout") // Held exactly as long as the phone relays.
  private fun holdLocks(decision: Decision) {
    if (wakeLock == null)
      wakeLock =
        getSystemService(PowerManager::class.java)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openbot:egress")
          .apply {
            setReferenceCounted(false)
            acquire()
          }
    // Newer Android versions ignore this lock; older ones keep Wi-Fi awake with it.
    val wantWifi = !decision.metered && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
    if (wantWifi && wifiLock == null) {
      @Suppress("DEPRECATION")
      wifiLock =
        applicationContext
          .getSystemService(WifiManager::class.java)
          .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "openbot:egress")
          .apply {
            setReferenceCounted(false)
            acquire()
          }
    } else if (!wantWifi) {
      wifiLock?.release()
      wifiLock = null
    }
  }

  private fun releaseLocks() {
    wakeLock?.release()
    wakeLock = null
    wifiLock?.release()
    wifiLock = null
  }

  private fun networkLabel(): String? =
    decision?.takeIf { it.reason == null && it.network != null }?.let { if (it.metered) "mobile" else "wifi" }

  private fun publish() {
    Egress.publish(
      ServiceStatus(
        running = running,
        connection = connection,
        detail = detail,
        role = role,
        network = networkLabel(),
        stats = agent?.stats,
      )
    )
  }

  private fun goForeground(title: String, text: String?) {
    val notification = Notices.ongoing(this, title, text)
    val type =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      else ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST
    ServiceCompat.startForeground(this, Notices.ONGOING_ID, notification, type)
  }

  /** The notification, at most every 10 seconds unless something important changed. */
  private fun updateNotification(force: Boolean = false) {
    if (!running) return
    val now = SystemClock.elapsedRealtime()
    if (!force && now - lastNotified < NOTIFICATION_EVERY_MS) {
      if (!notificationQueued) {
        notificationQueued = true
        main.postDelayed({
          notificationQueued = false
          updateNotification(force = true)
        }, NOTIFICATION_EVERY_MS - (now - lastNotified))
      }
      return
    }
    lastNotified = now
    val usage = DataUsage.read(this)
    val today = "${formatBytes(usage.todayBytes)} today"
    val reason = decision?.reason
    val (title, text) =
      when {
        reason != null -> Notices.reasonText(reason) to "Resumes on its own when it can · $today"
        connection == AgentStatus.ONLINE && role == AgentRole.STANDBY ->
          "Ready to browse for your teammates" to "Your Mac is carrying their traffic · $today"
        connection == AgentStatus.ONLINE ->
          "Browsing for your teammates through this phone" to
            "${if (decision?.metered == true) "Mobile data" else "Wi-Fi"} · $today"
        else -> "Connecting to open-bot" to (detail ?: today)
      }
    goForeground(title, text)
  }

  /** Stop for good: the agent, the watchers, the locks, the foreground notice. */
  private fun finish() {
    cleanUp()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
    Egress.changed()
  }

  private fun cleanUp() {
    running = false
    stopAgent(null)
    watcher.stop()
    releaseLocks()
    cancelGiveUp()
    main.removeCallbacksAndMessages(null)
    // The last bytes still count.
    DataUsage.add(this, meter.take(), decision?.metered == true)
    reported = null
    Egress.publish(ServiceStatus())
  }

  override fun onDestroy() {
    // Stopped by the system or by `stopService`: the run state stays, so a restart can resume.
    if (running) cleanUp()
    super.onDestroy()
  }
}

/** "42 MB", "1.2 GB": decimal units, as Android's data usage screens show them. */
internal fun formatBytes(bytes: Long): String =
  when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1e9)
    bytes >= 1_000_000 -> "${bytes / 1_000_000} MB"
    bytes >= 1_000 -> "${bytes / 1_000} KB"
    else -> "$bytes B"
  }
