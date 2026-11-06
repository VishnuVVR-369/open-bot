package dev.openbot.egress.core

import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.concurrent.thread
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The phone's agent against a stand-in web server (the token route) and relay (the tunnel). */
class AgentTest {
  private val threads = Threads()
  private val server = MockWebServer()
  private val echo = LocalServer.echo()
  private val credential = DeviceCredential("2c1f7a4e-8d0b-4f7e-9a51-6b3c2d1e0f9a", "s3cret", 3)
  private val meter = TrafficMeter()

  /** The relay's side of each tunnel. */
  private inner class Relay : WebSocketListener() {
    val sockets = Inbox<WebSocket>()
    val texts = Inbox<JSONObject>()
    val frames = Inbox<Frame>()
    val closes = Inbox<Int>()

    override fun onOpen(webSocket: WebSocket, response: Response) = sockets.put(webSocket)

    override fun onMessage(webSocket: WebSocket, text: String) = texts.put(JSONObject(text))

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) = frames.put(Frames.decode(bytes.toByteArray()))

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      closes.put(code)
      webSocket.close(1000, null)
    }

    /** The next frame of [type], skipping others. */
    fun frame(type: Int) = frames.takeMatching { it.type == type }

    /** The next control message of [type], skipping others. */
    fun text(type: String) = texts.takeMatching { it.optString("type") == type }
  }

  private val relay = Relay()
  private val tokenRequests = Inbox<RecordedRequest>()
  private val tunnelRequests = Inbox<RecordedRequest>()
  /** What the token route answers next; when empty, it grants a token. */
  private val tokenAnswers = ConcurrentLinkedQueue<MockResponse>()
  private var tunnelUrl: String? = null
  private var tokenCount = 0

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          when (request.requestUrl?.encodedPath) {
            "/api/egress/device/token" -> {
              tokenRequests.put(request)
              tokenAnswers.poll()
                ?: MockResponse()
                  .setBody(
                    JSONObject()
                      .put("url", tunnelUrl ?: "ws://${server.hostName}:${server.port}/egress/agent")
                      .put("token", "t-${++tokenCount}/+=")
                      .put("phoneMode", "always")
                      .put("generation", credential.generation)
                      .toString()
                  )
            }
            "/egress/agent" -> {
              tunnelRequests.put(request)
              MockResponse().withWebSocketUpgrade(relay)
            }
            else -> MockResponse().setResponseCode(404)
          }
      }
    server.start()
  }

  private sealed interface Event {
    data class Status(val status: AgentStatus, val detail: String?) : Event

    data class Role(val role: AgentRole) : Event

    data class Policy(val mode: PhoneMode) : Event

    data class Revoked(val generation: Int) : Event
  }

  private val events = Inbox<Event>()

  private val listener =
    object : AgentListener {
      override fun onStatus(status: AgentStatus, detail: String?) = events.put(Event.Status(status, detail))

      override fun onRole(role: AgentRole) = events.put(Event.Role(role))

      override fun onPolicy(mode: PhoneMode) = events.put(Event.Policy(mode))

      override fun onRevoked(generation: Int) = events.put(Event.Revoked(generation))
    }

  private fun agent(
    timings: AgentTimings = AgentTimings(firstBackoffMs = 50, maxBackoffMs = 200, statsMs = 100),
    lastReport: Long = 0,
  ) =
    EgressAgent(
      appUrl = server.url("/").toString(),
      credential = credential,
      client = { OkHttpClient() },
      connector = TcpConnector(threads.mux, threads.io, { LocalEgress({ echo.port }) }, meter, threads.scheduler),
      executor = threads.mux,
      listener = listener,
      meter = meter,
      timings = timings,
      lastReport = lastReport,
    )

  @Test
  fun `a callback after the agent's thread shut down is dropped, not thrown into OkHttp`() {
    // On Android an exception on OkHttp's threads ends the app.
    val uncaught = Inbox<Throwable>()
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { _, error -> uncaught.put(error) }
    try {
      tokenAnswers.add(MockResponse().setHeadersDelay(500, java.util.concurrent.TimeUnit.MILLISECONDS))
      val executor = EgressAgent.newExecutor()
      val agent =
        EgressAgent(
          appUrl = server.url("/").toString(),
          credential = credential,
          client = { OkHttpClient() },
          connector = TcpConnector(executor, threads.io, { LocalEgress({ echo.port }) }, meter, executor.asScheduler()),
          executor = executor,
          listener = listener,
          meter = meter,
        )
      agent.start()
      tokenRequests.take()
      // The service's order: stop, then shut the thread down. The cancelled token call reports
      // its failure afterwards.
      agent.stop()
      executor.shutdownWhenIdle()
      assertTrue(executor.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS))
      assertNull(uncaught.poll(1_000))
      // Calls after the shutdown are dropped too.
      agent.retryNow()
      var reported: Boolean? = null
      agent.reportUnavailable(UnavailableReason.LOW_BATTERY, 1) { reported = it }
      assertEquals(false, reported)
    } finally {
      Thread.setDefaultUncaughtExceptionHandler(previous)
    }
  }

  private var started: EgressAgent? = null

  private fun start(agent: EgressAgent = agent()) = agent.also {
    started = it
    it.start()
  }

  private fun online() = events.takeMatching { it == Event.Status(AgentStatus.ONLINE, null) }

  @AfterEach
  fun cleanUp() {
    started?.stop()
    threads.onMux {} // Let the stop run before the threads go.
    server.shutdown()
    echo.close()
    threads.close()
  }

  @Test
  fun `fetches a token with the device credential, follows its policy, and carries a connection`() {
    start()
    val token = tokenRequests.take()
    assertEquals("POST", token.method)
    assertEquals("Bearer s3cret", token.getHeader("Authorization"))
    assertEquals(credential.deviceId, token.getHeader("x-device-id"))
    assertEquals(Event.Policy(PhoneMode.ALWAYS), events.takeMatching { it is Event.Policy })
    assertEquals("t-1/+=", tunnelRequests.take().requestUrl?.queryParameter("token"))
    online()
    val tunnel = relay.sockets.take()

    tunnel.send(Frames.encode(FrameType.OPEN, 1, """{"host":"example.com","port":443}""").toByteString())
    assertEquals(1L, relay.frame(FrameType.OPEN_OK).streamId)
    tunnel.send(Frames.encode(FrameType.DATA, 1, "hello").toByteString())
    // The destination's write is credited, and its echo comes back, in either order.
    val replies = List(2) { relay.frames.takeMatching { it.type == FrameType.WINDOW || it.type == FrameType.DATA } }
    val byType = replies.associateBy { it.type }
    assertEquals(5L, Frames.readU32(byType.getValue(FrameType.WINDOW).payload, 0))
    assertEquals("hello", String(byType.getValue(FrameType.DATA).payload))
    assertEquals(1L, relay.text("stats").getLong("openStreams"))
    assertTrue(meter.take() >= 2 * 5 + 2 * (5 + 5)) // Both legs: the tunnel and the destination.
  }

  @Test
  fun `fetches a new token for every connection`() {
    start()
    tokenRequests.take()
    online()
    relay.sockets.take().close(1001, "Worker stopping")
    tokenRequests.take()
    online()
    assertEquals("t-2/+=", tunnelRequests.takeMatching { it.requestUrl?.queryParameter("token") == "t-2/+=" }.requestUrl?.queryParameter("token"))
  }

  @Test
  fun `follows the relay's role and policy, and stops when released`() {
    start()
    online()
    val tunnel = relay.sockets.take()
    tunnel.send("""{"type":"role","role":"standby"}""")
    assertEquals(Event.Role(AgentRole.STANDBY), events.takeMatching { it is Event.Role })
    tunnel.send("""{"type":"policy","phoneMode":"off"}""")
    assertEquals(Event.Policy(PhoneMode.OFF), events.takeMatching { it == Event.Policy(PhoneMode.OFF) })
    tunnel.send("""{"type":"role","role":"release"}""")
    assertEquals(Event.Role(AgentRole.RELEASE), events.takeMatching { it is Event.Role })
    assertEquals(AgentStatus.OFFLINE, (events.takeMatching { it is Event.Status } as Event.Status).status)
    assertEquals(1000, relay.closes.take())
    tokenRequests.take()
    assertNull(tokenRequests.poll(400)) // No reconnect after a release.
  }

  @Test
  fun `a peer-down drops the connections it carries`() {
    start()
    online()
    val tunnel = relay.sockets.take()
    tunnel.send(Frames.encode(FrameType.OPEN, 1, """{"host":"example.com","port":443}""").toByteString())
    relay.frame(FrameType.OPEN_OK)
    tunnel.send("""{"type":"peer-down"}""")
    // The stream is gone, so its data is refused.
    tunnel.send(Frames.encode(FrameType.DATA, 1, "late").toByteString())
    assertEquals(1L, relay.frame(FrameType.RESET).streamId)
  }

  @Test
  fun `stops for good when the relay says the pairing was revoked`() {
    start()
    online()
    relay.sockets.take().close(CLOSE_REVOKED, "revoked")
    assertEquals(Event.Revoked(3), events.takeMatching { it is Event.Revoked })
    tokenRequests.take()
    assertNull(tokenRequests.poll(400))
  }

  @Test
  fun `stops for good when the token route refuses the credential`() {
    tokenAnswers.add(MockResponse().setResponseCode(401).setBody("""{"error":"revoked"}"""))
    start()
    assertEquals(Event.Revoked(3), events.takeMatching { it is Event.Revoked })
    tokenRequests.take()
    assertNull(tokenRequests.poll(400))
  }

  @Test
  fun `backs off, doubling up to the limit, while the token route fails`() {
    repeat(6) { tokenAnswers.add(MockResponse().setResponseCode(503)) }
    start()
    val times = (0 until 6).map { tokenRequests.take(); System.nanoTime() / 1_000_000 }
    val gaps = times.zipWithNext { a, b -> b - a }
    // The relay never answered, so the backoff was never reset: 50, 100, 200, then 200.
    listOf(50L, 100L, 200L, 200L, 200L).zip(gaps).forEach { (least, gap) -> assertTrue(gap >= least - 5, "gaps $gaps") }
    val offline = events.takeMatching { it is Event.Status && it.status == AgentStatus.OFFLINE } as Event.Status
    assertEquals("open-bot returned 503", offline.detail)
    // Then it connects.
    online()
  }

  @Test
  fun `reports why it can't carry traffic over the tunnel, only while connected`() {
    val agent = agent(lastReport = 4)
    val answers = Inbox<Boolean>()
    agent.reportUnavailable(UnavailableReason.LOW_BATTERY, 4) { answers.put(it) }
    assertFalse(answers.take())
    start(agent)
    online()
    // First thing on the tunnel: the reports so far are over.
    assertEquals("""{"type":"available","seq":4}""", relay.texts.take().toString())
    agent.reportUnavailable(UnavailableReason.LOW_BATTERY, 5) { answers.put(it) }
    assertTrue(answers.take())
    val report = relay.text("unavailable")
    assertEquals("low-battery", report.getString("reason"))
    assertEquals(5, report.getLong("seq"))
  }

  @Test
  fun `reconnects when the relay stops answering pings`() {
    // A relay that accepts the websocket and then goes silent, never answering a ping.
    val silent = ServerSocket(0)
    thread(isDaemon = true) {
      while (!silent.isClosed) {
        val socket = runCatching { silent.accept() }.getOrNull() ?: break
        thread(isDaemon = true) {
          val reader = socket.getInputStream().bufferedReader()
          val key = generateSequence { reader.readLine() }.takeWhile { it.isNotEmpty() }
            .first { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }.substringAfter(":").trim()
          val accept =
            Base64.getEncoder()
              .encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
          socket.getOutputStream().write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray()
          )
          socket.getOutputStream().flush()
        }
      }
    }
    try {
      tunnelUrl = "ws://127.0.0.1:${silent.localPort}/egress/agent"
      start(agent(AgentTimings(pingMs = 100, firstBackoffMs = 50, maxBackoffMs = 200, statsMs = 10_000)))
      tokenRequests.take()
      online()
      val offline = events.takeMatching { it is Event.Status && it.status == AgentStatus.OFFLINE } as Event.Status
      assertTrue(offline.detail!!.contains("pong"), offline.detail)
      tokenRequests.take(2_000)
    } finally {
      silent.close()
    }
  }
}

class ExecutorTest {
  @Test
  fun `shutting down when idle runs what was queued, and drops timers`() {
    val executor = EgressAgent.newExecutor()
    val ran = Inbox<String>()
    executor.schedule({ ran.put("timer") }, 50, java.util.concurrent.TimeUnit.MILLISECONDS)
    executor.execute { ran.put("queued") }
    executor.shutdownWhenIdle()
    assertEquals("queued", ran.take())
    assertTrue(executor.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS))
    assertNull(ran.poll(100))
  }

  @Test
  fun `a stop queued before shutting down still closes the tunnel`() {
    // The service's order: report, stop, then shut the agent's thread down.
    val executor = EgressAgent.newExecutor()
    val closed = Inbox<Int>()
    val server = MockWebServer()
    server.enqueue(
      MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            closed.put(code)
            webSocket.close(1000, null)
          }
        }
      )
    )
    server.start()
    val socket = OkHttpClient().newWebSocket(okhttp3.Request.Builder().url(server.url("/")).build(), object : WebSocketListener() {})
    Thread.sleep(200)
    executor.execute { socket.close(1000, "Paused: battery low") }
    executor.shutdownWhenIdle()
    assertEquals(1000, closed.take())
    server.shutdown()
  }
}
