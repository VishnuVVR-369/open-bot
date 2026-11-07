package dev.openbot.egress.core

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NetworkTest {
  private val threads = Threads()
  private val meter = TrafficMeter()
  private val closeables = mutableListOf<AutoCloseable>()

  @AfterEach
  fun cleanUp() {
    closeables.forEach { it.close() }
    threads.close()
  }

  private fun <T : AutoCloseable> T.closing(): T = also { closeables.add(it) }

  private fun connector(egress: Egress, timeoutMs: Long = CONNECT_TIMEOUT_MS) =
    TcpConnector(threads.mux, threads.io, { egress }, meter, threads.scheduler, timeoutMs)

  /** Connect on the mux's thread and wait for the result. */
  private fun connect(connector: TcpConnector, host: String, port: Int = 443, cancel: CancelSignal = CancelSignal()): Result<MuxSocket> {
    val result = Inbox<Result<MuxSocket>>()
    threads.mux.execute { connector.connect(host, port, cancel) { result.put(it) } }
    return result.take()
  }

  private sealed interface Event {
    data class Data(val bytes: ByteArray) : Event

    data object End : Event

    data class Error(val error: Throwable) : Event

    data class Close(val hadError: Boolean) : Event
  }

  private class Recorder : SocketEvents {
    val events = Inbox<Event>()
    val thread = Inbox<String>()

    override fun onData(chunk: ByteArray) {
      thread.put(Thread.currentThread().name)
      events.put(Event.Data(chunk))
    }

    override fun onEnd() = events.put(Event.End)

    override fun onError(error: Throwable) = events.put(Event.Error(error))

    override fun onClose(hadError: Boolean) = events.put(Event.Close(hadError))

    /** Data until [length] bytes arrived. */
    fun read(length: Int): ByteArray {
      var all = ByteArray(0)
      while (all.size < length) all += (events.take() as Event.Data).bytes
      return all
    }
  }

  @Test
  fun `connects to the checked address and carries data both ways, on the mux's thread`() {
    val server = LocalServer.echo().closing()
    val egress = LocalEgress({ server.port })
    val socket = connect(connector(egress), "example.com").getOrThrow()
    assertEquals(listOf(InetSocketAddress(InetAddress.getByName("93.184.215.14"), 443)), egress.connectedTo)
    val recorder = Recorder()
    val written = Inbox<String>()
    threads.onMux {
      socket.start(recorder)
      assertTrue(socket.isPaused) // Starts paused, like the Node socket the mux expects.
      socket.resume()
      socket.write("hello".toByteArray()) { written.put(Thread.currentThread().name) }
    }
    assertEquals("egress-agent", written.take())
    assertEquals("hello", String(recorder.read(5)))
    assertEquals("egress-agent", recorder.thread.take())
    // Our end makes the echo server finish, and then the socket closes cleanly.
    threads.onMux { socket.end() }
    assertEquals(Event.End, recorder.events.take())
    assertEquals(Event.Close(false), recorder.events.take())
    assertEquals(10L, meter.take()) // 5 written and 5 read; the agent counts the tunnel leg.
  }

  @Test
  fun `stops reading while paused`() {
    val sent = CountDownLatch(1)
    val server =
      LocalServer { socket ->
          socket.getOutputStream().write("ping".toByteArray())
          socket.getOutputStream().flush()
          sent.countDown()
          Thread.sleep(5_000)
        }
        .closing()
    val socket = connect(connector(LocalEgress({ server.port })), "example.com").getOrThrow()
    val recorder = Recorder()
    threads.onMux { socket.start(recorder) }
    sent.await()
    assertNull(recorder.events.poll(200))
    threads.onMux { socket.resume() }
    assertEquals("ping", String(recorder.read(4)))
  }

  @Test
  fun `when the destination finishes, this side finishes after its writes`() {
    val server =
      LocalServer { socket ->
          socket.getOutputStream().write("bye".toByteArray())
          socket.shutdownOutput()
          // Read what the client still sends, until it finishes too.
          socket.getInputStream().readBytes()
        }
        .closing()
    val socket = connect(connector(LocalEgress({ server.port })), "example.com").getOrThrow()
    val recorder = Recorder()
    threads.onMux {
      socket.start(recorder)
      socket.resume()
    }
    assertEquals("bye", String(recorder.read(3)))
    assertEquals(Event.End, recorder.events.take())
    assertEquals(Event.Close(false), recorder.events.take())
  }

  @Test
  fun `a destination that resets reports an error, then a close`() {
    val reset = Inbox<Unit>()
    val server =
      LocalServer { socket ->
          // Wait for the client to connect and install its handlers before sending the reset.
          reset.take()
          socket.setSoLinger(true, 0)
          socket.close()
        }
        .closing()
    val socket = connect(connector(LocalEgress({ server.port })), "example.com").getOrThrow()
    val recorder = Recorder()
    threads.onMux {
      socket.start(recorder)
      socket.resume()
    }
    reset.put(Unit)
    val first = recorder.events.take()
    // A reset arriving before anything is read can surface as a plain end on some systems.
    if (first is Event.Error) assertEquals(Event.Close(true), recorder.events.take())
    else assertEquals(Event.End, first)
  }

  @Test
  fun `nothing is delivered after destroy`() {
    val server = LocalServer.echo().closing()
    val socket = connect(connector(LocalEgress({ server.port })), "example.com").getOrThrow()
    val recorder = Recorder()
    threads.onMux {
      socket.start(recorder)
      socket.resume()
      socket.write("x".toByteArray()) {}
      socket.destroy()
    }
    assertNull(recorder.events.poll(300))
  }

  @Test
  fun `refuses private destinations, by literal and by name`() {
    val egress = LocalEgress({ 1 }, answers = listOf("93.184.215.14", "192.168.0.1"))
    for (host in listOf("10.0.0.1", "[::1]", "::ffff:127.0.0.1", "mixed.example")) {
      val error = connect(connector(egress), host).exceptionOrNull()
      assertTrue(error is BlockedDestinationException, "$host: $error")
    }
    assertTrue(egress.connectedTo.isEmpty())
  }

  @Test
  fun `refuses invalid ports`() {
    for (port in listOf(0, -1, 65_536))
      assertEquals("Invalid port", connect(connector(LocalEgress({ 1 })), "example.com", port).exceptionOrNull()?.message)
  }

  @Test
  fun `reports a refused connection`() {
    val unused = java.net.ServerSocket(0).use { it.localPort }
    val error = connect(connector(LocalEgress({ unused })), "example.com").exceptionOrNull()
    assertTrue(error is IOException && error.message!!.startsWith("Connection refused"), "$error")
  }

  /** An egress whose name lookups wait until the test lets them go. */
  private class SlowEgress(port: Int) : Egress by LocalEgress({ port }) {
    val release = CountDownLatch(1)

    override fun lookup(host: String): List<InetAddress> {
      release.await()
      return listOf(InetAddress.getByName("93.184.215.14"))
    }
  }

  @Test
  fun `the lookup and the connect share one time limit`() {
    val egress = SlowEgress(1)
    val error = connect(connector(egress, timeoutMs = 200), "example.com").exceptionOrNull()
    assertEquals("Timed out connecting to example.com:443", error?.message)
    egress.release.countDown()
  }

  @Test
  fun `a cancelled connection fails at once`() {
    val egress = SlowEgress(1)
    val cancel = CancelSignal()
    val result = Inbox<Result<MuxSocket>>()
    threads.mux.execute { connector(egress).connect("example.com", 443, cancel) { result.put(it) } }
    cancel.cancel()
    assertEquals("Connection cancelled", result.take().exceptionOrNull()?.message)
    egress.release.countDown()
  }

  @Test
  fun `reads no further ahead than one chunk the mux hasn't handled, so a pause applies at once`() {
    // A fast destination, and a mux thread that is busy: it runs tasks only when the test says.
    val source = LocalServer { socket -> socket.use { it.getOutputStream().write(ByteArray(32 * 1024 * 1024)) } }.closing()
    val held = java.util.concurrent.LinkedBlockingQueue<Runnable>()
    val socket = BlockingMuxSocket(java.net.Socket(InetAddress.getLoopbackAddress(), source.port), { held.put(it) }, threads.io, meter)
    var received = 0
    socket.start(
      object : SocketEvents {
        override fun onData(chunk: ByteArray) {
          received += chunk.size
          socket.pause() // As the mux does when the stream's window is used up.
        }

        override fun onEnd() {}

        override fun onError(error: Throwable) {}

        override fun onClose(hadError: Boolean) {}
      }
    )
    socket.resume()
    Thread.sleep(300)
    assertEquals(1, held.size)
    held.take().run()
    Thread.sleep(300)
    assertEquals(0, held.size)
    assertTrue(received in 1..64 * 1024)
    socket.destroy()
  }
}
