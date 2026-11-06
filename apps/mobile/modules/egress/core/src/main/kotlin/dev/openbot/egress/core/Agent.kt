package dev.openbot.egress.core

import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/** What the phone signs in with: made at pairing, stored encrypted, never seen by JavaScript. */
data class DeviceCredential(val deviceId: String, val secret: String, val generation: Int) {
  override fun toString() = "DeviceCredential($deviceId, generation $generation)"
}

enum class AgentStatus {
  CONNECTING,
  ONLINE,
  OFFLINE,
}

/** What the agent tells its owner (the Android service). Called on the agent's thread. */
interface AgentListener {
  fun onStatus(status: AgentStatus, detail: String?) {}

  /** The relay's wish for this phone. After [AgentRole.RELEASE] the agent has already stopped. */
  fun onRole(role: AgentRole) {}

  /** The owner's phone mode, from the token response and from `policy` messages. */
  fun onPolicy(mode: PhoneMode) {}

  /**
   * The server turned this device off. [generation] is the credential generation the refusal
   * answered, so a pairing made meanwhile can be kept. The agent has already stopped for good.
   */
  fun onRevoked(generation: Int) {}
}

data class AgentTimings(
  val pingMs: Long = 15_000,
  val firstBackoffMs: Long = 1_000,
  val maxBackoffMs: Long = 15_000,
  val statsMs: Long = 5_000,
)

/** Bytes the phone moved, on the tunnel and to destinations, for the data cap. Thread-safe. */
class TrafficMeter {
  private val total = AtomicLong()

  fun add(bytes: Long) {
    if (bytes > 0) total.addAndGet(bytes)
  }

  /** The bytes counted since the last call. */
  fun take(): Long = total.getAndSet(0)
}

/** The close code the relay uses when this device's pairing was revoked. */
const val CLOSE_REVOKED = 4401

/**
 * The phone's egress agent: fetches a token, keeps the tunnel to the worker's relay open, and
 * carries the computer's connections through [AgentMux].
 *
 * Every piece of state lives on [executor], a single thread shared with the [Connector]'s
 * callbacks; the public methods can be called from any thread.
 */
class EgressAgent(
  private val appUrl: String,
  private val credential: DeviceCredential,
  /** The HTTP client for the token and the tunnel, fresh per attempt so it follows the network. */
  private val client: () -> OkHttpClient,
  private val connector: Connector,
  private val executor: ScheduledExecutorService,
  private val listener: AgentListener,
  private val meter: TrafficMeter = TrafficMeter(),
  private val timings: AgentTimings = AgentTimings(),
  private val log: (String) -> Unit = {},
  /**
   * The number of the phone's latest unavailable report when this agent was made, which each of
   * its connections says is over. A pause always stops the agent, so its own report is newer.
   */
  private val lastReport: Long = 0,
) {
  /** One attempt at a tunnel: the token request, then the websocket. */
  private inner class Session {
    var call: Call? = null
    var socket: WebSocket? = null
    var mux: AgentMux? = null
    var stats: Cancellable? = null
    /** Set once the socket is unusable, so nothing more is sent on it. */
    var dead = false
  }

  private var session: Session? = null
  private var stopped = true
  private var attempt = 0
  private var reconnect: Cancellable? = null

  @Volatile
  var status: AgentStatus = AgentStatus.OFFLINE
    private set

  @Volatile
  var stats: MuxStats = MuxStats(0, 0, 0)
    private set

  private val scheduler = executor.asScheduler()

  /**
   * Run [task] on the agent's thread. OkHttp's callbacks can still arrive after the service shut
   * the thread down (a cancelled call reports its failure); they are dropped, since an exception
   * thrown into OkHttp's threads would end the app.
   */
  private fun post(task: () -> Unit): Boolean =
    try {
      executor.execute(task)
      true
    } catch (_: RejectedExecutionException) {
      false // Shut down: nothing is left to tell.
    }

  fun start() {
    post {
      if (!stopped) return@post
      stopped = false
      attempt = 0
      connect()
    }
  }

  /** Try again at once, for example when a usable network appears. */
  fun retryNow() {
    post {
      if (stopped || session != null) return@post
      reconnect?.cancel()
      reconnect = null
      attempt = 0
      connect()
    }
  }

  fun stop(reason: String = "Agent stopped") {
    post { shutDown(reason) }
  }

  /**
   * Tell the relay why the phone can't carry traffic, if the tunnel is open. Returns through
   * [done] whether it was sent; if not, the caller reports through the device route instead.
   */
  fun reportUnavailable(reason: UnavailableReason, seq: Long, done: (Boolean) -> Unit) {
    val queued = post {
      val current = session
      val socket = current?.socket
      done(
        status == AgentStatus.ONLINE &&
          current != null &&
          socket != null &&
          sendText(current, socket, Control.encode(ControlMessage.Unavailable(reason, seq)))
      )
    }
    if (!queued) done(false)
  }

  private fun setStatus(next: AgentStatus, detail: String? = null) {
    status = next
    listener.onStatus(next, detail)
  }

  private fun connect() {
    if (stopped) return
    val current = Session()
    session = current
    setStatus(AgentStatus.CONNECTING)
    val request =
      Request.Builder()
        .url(appUrl.trimEnd('/') + "/api/egress/device/token")
        .header("Authorization", "Bearer ${credential.secret}")
        .header("x-device-id", credential.deviceId)
        .post("{}".toRequestBody("application/json".toMediaType()))
        .build()
    val http = client()
    val call = http.newCall(request)
    current.call = call
    call.enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          post { tokenFailed(current, e.message ?: "Could not reach open-bot") }
        }

        override fun onResponse(call: Call, response: Response) {
          val outcome = response.use { readToken(it) }
          post {
            when (outcome) {
              is TokenOutcome.Revoked -> if (session === current) revoked()
              is TokenOutcome.Failed -> tokenFailed(current, outcome.reason)
              is TokenOutcome.Granted -> openTunnel(current, http, outcome)
            }
          }
        }
      }
    )
  }

  private sealed interface TokenOutcome {
    data object Revoked : TokenOutcome

    data class Failed(val reason: String) : TokenOutcome

    data class Granted(val url: String, val token: String, val phoneMode: PhoneMode?) : TokenOutcome
  }

  private fun readToken(response: Response): TokenOutcome {
    if (response.code == 401) return TokenOutcome.Revoked
    if (!response.isSuccessful) return TokenOutcome.Failed("open-bot returned ${response.code}")
    return try {
      val body = JSONObject(response.body?.string() ?: "")
      val url = body.optString("url")
      val token = body.optString("token")
      if (url.isEmpty() || token.isEmpty()) TokenOutcome.Failed("open-bot sent no tunnel token")
      else TokenOutcome.Granted(url, token, PhoneMode.fromWire(body.opt("phoneMode")))
    } catch (error: Exception) {
      TokenOutcome.Failed("open-bot sent an unreadable token")
    }
  }

  private fun tokenFailed(current: Session, reason: String) {
    if (session !== current) return
    session = null
    scheduleReconnect(reason)
  }

  private fun openTunnel(current: Session, http: OkHttpClient, granted: TokenOutcome.Granted) {
    if (session !== current) return
    granted.phoneMode?.let(listener::onPolicy)
    if (session !== current) return // The listener stopped the agent.
    val url = granted.url + "?token=" + URLEncoder.encode(granted.token, "UTF-8")
    val tunnel = http.newBuilder().pingInterval(timings.pingMs, TimeUnit.MILLISECONDS).build()
    current.socket =
      tunnel.newWebSocket(
        Request.Builder().url(url).build(),
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) {
            post { opened(current, webSocket) }
          }

          override fun onMessage(webSocket: WebSocket, text: String) {
            post { received(current, text) }
          }

          override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            post { received(current, bytes.toByteArray()) }
          }

          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            post { closed(current, code, reason) }
          }

          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            post { closed(current, code, reason) }
          }

          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            post {
              closed(current, 1006, response?.let { "The relay returned ${it.code}" } ?: (t.message ?: "Disconnected"))
            }
          }
        },
      )
  }

  private fun opened(current: Session, socket: WebSocket) {
    if (session !== current || current.dead) return
    val mux =
      AgentMux(
        send = { frame -> send(current, socket, frame) },
        connector = connector,
        scheduler = scheduler,
        transportBuffered = { socket.queueSize() },
      )
    current.mux = mux
    // Before anything else, so a report still on its way through the device route can't count.
    if (!sendText(current, socket, Control.encode(ControlMessage.Available(lastReport)))) return
    setStatus(AgentStatus.ONLINE)
    scheduleStats(current, socket, mux)
  }

  private fun scheduleStats(current: Session, socket: WebSocket, mux: AgentMux) {
    current.stats =
      scheduler.schedule(timings.statsMs) {
        if (session !== current || current.dead) return@schedule
        val now = mux.stats
        stats = now
        sendText(current, socket, Control.encode(ControlMessage.Stats(now.openStreams.toLong(), now.bytesIn, now.bytesOut)))
        scheduleStats(current, socket, mux)
      }
  }

  private fun received(current: Session, text: String) {
    if (session !== current || current.dead) return
    meter.add(text.length.toLong())
    // The relay always speaks first once it has accepted this phone: only then is the backoff reset.
    attempt = 0
    when (val message = Control.parse(text)) {
      ControlMessage.PeerDown -> current.mux?.resetAll()
      is ControlMessage.Role -> {
        listener.onRole(message.role)
        if (message.role == AgentRole.RELEASE) shutDown("Released by the relay")
      }
      is ControlMessage.Policy -> listener.onPolicy(message.phoneMode)
      else -> Unit
    }
  }

  private fun received(current: Session, frame: ByteArray) {
    if (session !== current || current.dead) return
    meter.add(frame.size.toLong())
    val mux = current.mux ?: return
    try {
      mux.handleFrame(frame)
    } catch (error: MalformedFrameException) {
      log("Dropped a malformed frame: ${error.message}")
    }
  }

  private fun send(current: Session, socket: WebSocket, frame: ByteArray) {
    if (current.dead) return
    meter.add(frame.size.toLong())
    if (!socket.send(frame.toByteString())) lost(current, socket)
  }

  private fun sendText(current: Session, socket: WebSocket, text: String): Boolean {
    if (current.dead) return false
    meter.add(text.length.toLong())
    if (socket.send(text)) return true
    lost(current, socket)
    return false
  }

  /**
   * OkHttp refuses a send once the socket is closing, or closes it when its queue passes 16 MiB.
   * Either way the tunnel is gone. The close is handled on a later turn, since this can run in
   * the middle of a mux operation.
   */
  private fun lost(current: Session, socket: WebSocket) {
    if (current.dead) return
    current.dead = true
    socket.cancel()
    post { closed(current, 1006, "The tunnel's send queue failed") }
  }

  private fun closed(current: Session, code: Int, reason: String) {
    if (session !== current) return
    session = null
    end(current)
    if (code == CLOSE_REVOKED) revoked()
    else scheduleReconnect(reason.ifEmpty { "Disconnected ($code)" })
  }

  /** Close a session's resources. */
  private fun end(current: Session) {
    current.dead = true
    current.call?.cancel()
    current.stats?.cancel()
    current.mux?.resetAll()
    current.socket?.cancel()
  }

  private fun revoked() {
    shutDown("This phone's pairing was turned off")
    listener.onRevoked(credential.generation)
  }

  private fun shutDown(reason: String) {
    if (stopped) return
    stopped = true
    reconnect?.cancel()
    reconnect = null
    session?.let { current ->
      session = null
      current.dead = true
      current.call?.cancel()
      current.stats?.cancel()
      current.mux?.resetAll()
      // A clean close, so the relay knows at once instead of waiting for its heartbeat.
      current.socket?.close(1000, reason.take(120))
    }
    stats = MuxStats(0, 0, 0)
    setStatus(AgentStatus.OFFLINE, reason)
  }

  private fun scheduleReconnect(reason: String) {
    if (stopped) return
    setStatus(AgentStatus.OFFLINE, reason)
    val delay = minOf(timings.maxBackoffMs, timings.firstBackoffMs shl minOf(attempt, 20))
    attempt += 1
    reconnect =
      scheduler.schedule(delay) {
        reconnect = null
        connect()
      }
  }

  companion object {
    /**
     * The agent's thread, which the [Connector]'s callbacks must also use. Shut it down with
     * [shutdownWhenIdle]: `execute` queues zero-delay scheduled tasks, so a plain `shutdown` would
     * drop a `stop` queued just before it, along with the timers.
     */
    fun newExecutor(): ScheduledExecutorService =
      ScheduledThreadPoolExecutor(1) { task -> Thread(task, "egress-agent").apply { isDaemon = true } }.apply {
        executeExistingDelayedTasksAfterShutdownPolicy = false
        removeOnCancelPolicy = true
      }
  }
}

/**
 * Shut down once the tasks queued so far (like [EgressAgent.stop]) have run. Timers still
 * pending then (reconnects, connect timeouts) are dropped.
 */
fun ScheduledExecutorService.shutdownWhenIdle() = execute { shutdown() }

/** Runs [Scheduler] tasks on this executor. */
fun ScheduledExecutorService.asScheduler(): Scheduler = Scheduler { delayMs, task ->
  try {
    val future = schedule({ task() }, delayMs, TimeUnit.MILLISECONDS)
    Cancellable { future.cancel(false) }
  } catch (_: RejectedExecutionException) {
    Cancellable {} // Shut down: the timer could never fire anyway.
  }
}
