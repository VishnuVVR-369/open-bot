package dev.openbot.egress.core

import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.ArrayDeque
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory

/** How long making one connection may take, the name lookup included. */
const val CONNECT_TIMEOUT_MS = 15_000L
private const val READ_BUFFER = 64 * 1024

/** Where destination connections go out: the network the phone is allowed to use right now. */
interface Egress {
  val socketFactory: SocketFactory

  fun lookup(host: String): List<InetAddress>

  /** The network's own NAT64 prefixes (Android's `LinkProperties.getNat64Prefix()`). */
  val nat64: List<Nat64Prefix>

  companion object {
    /** The default network, for tests and the JVM. */
    val DEFAULT =
      object : Egress {
        override val socketFactory: SocketFactory = SocketFactory.getDefault()

        override fun lookup(host: String): List<InetAddress> = InetAddress.getAllByName(host).toList()

        override val nat64: List<Nat64Prefix> = emptyList()
      }
  }
}

/** Threads for blocking socket work: a reader per open socket, and a writer while it writes. */
fun newIoPool(): ExecutorService {
  val count = AtomicInteger()
  return ThreadPoolExecutor(0, Int.MAX_VALUE, 30, TimeUnit.SECONDS, SynchronousQueue()) { task ->
    // Small stacks: up to two threads for each of 256 streams.
    Thread(null, task, "egress-io-${count.incrementAndGet()}", 256L * 1024).apply { isDaemon = true }
  }
}

/**
 * Opens destination connections for the mux: checks the policy, resolves the name, and connects
 * to the address that was checked, all within [timeoutMs]. The timer closes a connection still
 * being made, so the lookup and the connect share the one limit.
 */
class TcpConnector(
  /** The mux's thread. */
  private val muxThread: Executor,
  private val io: ExecutorService,
  private val egress: () -> Egress,
  private val meter: TrafficMeter,
  private val scheduler: Scheduler,
  private val timeoutMs: Long = CONNECT_TIMEOUT_MS,
) : Connector {
  override fun connect(host: String, port: Int, cancel: CancelSignal, done: (Result<MuxSocket>) -> Unit) {
    val settled = AtomicBoolean(false)
    fun settle(result: Result<MuxSocket>) {
      if (!settled.compareAndSet(false, true)) {
        result.getOrNull()?.destroy()
        return
      }
      try {
        muxThread.execute { done(result) }
      } catch (_: RejectedExecutionException) {
        result.getOrNull()?.destroy() // The agent shut down meanwhile.
      }
    }
    if (port !in 1..65_535) {
      settle(Result.failure(IOException("Invalid port")))
      return
    }
    val target = egress()
    var socket: Socket? = null
    val lock = Any()
    fun abort(reason: String) {
      synchronized(lock) { socket?.closeQuietly() }
      settle(Result.failure(IOException(reason)))
    }
    val timeout = scheduler.schedule(timeoutMs) { abort("Timed out connecting to $host:$port") }
    cancel.onCancel { abort("Connection cancelled") }
    io.execute {
      try {
        val address =
          Destinations.choose(
            host,
            target.nat64,
            literal = { InetAddress.getByName(it) },
            resolve = { name ->
              target.lookup(name).map { ResolvedAddress(it.hostAddress ?: "", if (it is Inet4Address) 4 else 6, it) }
            },
          )
        val opened = target.socketFactory.createSocket()
        synchronized(lock) {
          if (settled.get()) {
            opened.closeQuietly()
            return@execute
          }
          socket = opened
        }
        opened.tcpNoDelay = true
        opened.connect(InetSocketAddress(address, port), timeoutMs.toInt())
        timeout.cancel()
        settle(Result.success(BlockingMuxSocket(opened, muxThread, io, meter)))
      } catch (error: Exception) {
        timeout.cancel()
        synchronized(lock) { socket?.closeQuietly() }
        settle(Result.failure(error.asConnectError(host, port)))
      }
    }
  }

  private fun Exception.asConnectError(host: String, port: Int): Exception =
    when (this) {
      is BlockedDestinationException,
      is UnresolvedHostException -> this
      is java.net.UnknownHostException -> UnresolvedHostException(host)
      is java.net.ConnectException -> IOException("Connection refused by $host:$port")
      is java.net.SocketTimeoutException -> IOException("Timed out connecting to $host:$port")
      else -> IOException(message ?: "Could not connect to $host:$port")
    }
}

private fun Socket.closeQuietly() {
  try {
    close()
  } catch (_: IOException) {}
}

/**
 * A connected socket driven the way Node drives one, which is what [AgentMux] expects: it starts
 * paused; reading happens on its own thread, at most one chunk ahead of the mux, and stops while
 * paused; writes queue and complete in order; and when the destination finishes sending, this
 * side finishes too once its writes are done (Node's `allowHalfOpen: false`).
 *
 * Events and write callbacks are delivered on [muxThread]. After [destroy] nothing more is
 * delivered.
 */
class BlockingMuxSocket(
  private val socket: Socket,
  private val muxThread: Executor,
  private val io: Executor,
  private val meter: TrafficMeter,
) : MuxSocket {
  private sealed interface Op {
    class Write(val chunk: ByteArray, val onWritten: () -> Unit) : Op

    data object End : Op
  }

  private val lock = Object()
  private var events: SocketEvents? = null
  private var paused = true
  /** A chunk read but not yet handed to the mux: the next read waits, so a pause applies at once. */
  private var delivering = false
  private var destroyed = false
  private var readEnded = false
  private var writeEnded = false
  private var closeSent = false
  private val writes = ArrayDeque<Op>()
  private var writing = false
  private var endQueued = false

  override val isPaused: Boolean
    get() = synchronized(lock) { paused }

  override fun start(events: SocketEvents) {
    synchronized(lock) { this.events = events }
    io.execute { readLoop() }
  }

  override fun write(chunk: ByteArray, onWritten: () -> Unit) = enqueue(Op.Write(chunk, onWritten))

  override fun end() {
    synchronized(lock) {
      if (endQueued) return
      endQueued = true
    }
    enqueue(Op.End)
  }

  override fun destroy() {
    synchronized(lock) {
      if (destroyed) return
      destroyed = true
      writes.clear()
      lock.notifyAll()
    }
    socket.closeQuietly()
  }

  override fun pause() = synchronized(lock) { paused = true }

  override fun resume() =
    synchronized(lock) {
      paused = false
      lock.notifyAll()
    }

  private fun enqueue(op: Op) {
    val startWriter =
      synchronized(lock) {
        if (destroyed) return
        writes.add(op)
        if (writing) false else true.also { writing = true }
      }
    if (startWriter) io.execute { writeLoop() }
  }

  private fun readLoop() {
    val buffer = ByteArray(READ_BUFFER)
    val input =
      try {
        socket.getInputStream()
      } catch (error: IOException) {
        fail(error)
        return
      }
    while (true) {
      synchronized(lock) {
        while ((paused || delivering) && !destroyed) lock.wait()
        if (destroyed) return
      }
      val count =
        try {
          input.read(buffer)
        } catch (error: IOException) {
          fail(error)
          return
        }
      if (count < 0) {
        readFinished()
        return
      }
      if (count == 0) continue
      meter.add(count.toLong())
      val chunk = buffer.copyOf(count)
      synchronized(lock) { delivering = true }
      deliver { events ->
        try {
          events.onData(chunk)
        } finally {
          synchronized(lock) {
            delivering = false
            lock.notifyAll()
          }
        }
      }
    }
  }

  private fun writeLoop() {
    val output =
      try {
        socket.getOutputStream()
      } catch (error: IOException) {
        fail(error)
        return
      }
    while (true) {
      val op =
        synchronized(lock) {
          if (destroyed) {
            writing = false
            return
          }
          writes.poll() ?: run {
            writing = false
            return
          }
        }
      try {
        when (op) {
          is Op.Write -> {
            output.write(op.chunk)
            output.flush()
            meter.add(op.chunk.size.toLong())
            deliver { op.onWritten() }
          }
          Op.End -> {
            socket.shutdownOutput()
            synchronized(lock) { writeEnded = true }
            maybeClose()
          }
        }
      } catch (error: IOException) {
        synchronized(lock) { writing = false }
        fail(error)
        return
      }
    }
  }

  /** The destination finished sending: tell the mux, then finish this side as Node does. */
  private fun readFinished() {
    synchronized(lock) { readEnded = true }
    deliver { it.onEnd() }
    end()
    maybeClose()
  }

  private fun maybeClose() {
    val close =
      synchronized(lock) {
        if (!readEnded || !writeEnded || closeSent || destroyed) false else true.also { closeSent = true }
      }
    if (!close) return
    socket.closeQuietly()
    deliver { it.onClose(false) }
  }

  private fun fail(error: IOException) {
    val report =
      synchronized(lock) {
        if (destroyed || closeSent) false else true.also { closeSent = true }
      }
    if (!report) return
    deliver { events ->
      events.onError(error)
      events.onClose(true)
    }
  }

  /** Run [event] on the mux's thread, unless the socket was destroyed meanwhile. */
  private fun deliver(event: (SocketEvents) -> Unit) {
    try {
      muxThread.execute {
        val target = synchronized(lock) { if (destroyed) null else events } ?: return@execute
        event(target)
      }
    } catch (_: RejectedExecutionException) {
      destroy() // The agent shut down meanwhile.
    }
  }
}
