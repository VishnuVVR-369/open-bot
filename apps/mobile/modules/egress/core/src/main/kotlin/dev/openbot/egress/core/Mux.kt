package dev.openbot.egress.core

import org.json.JSONObject

/** Bytes a side may send on one stream before the receiver grants more credit. */
const val INITIAL_WINDOW = 1024L * 1024
/** The most stream data a side keeps sent but not yet credited, across all its streams. */
const val MAX_IN_FLIGHT = 8L * 1024 * 1024
/** Above this many bytes waiting in the transport (the websocket), reading stops... */
const val TRANSPORT_HIGH_WATER = 4L * 1024 * 1024
/** ...and resumes below this many. */
const val TRANSPORT_LOW_WATER = 1024L * 1024
const val MAX_FRAME_PAYLOAD = 64 * 1024
/** How often to check a transport that has no drain event (OkHttp), while it's too full. */
const val TRANSPORT_POLL_MS = 50L
/** The most streams the phone carries at once. */
const val MAX_STREAMS = 256

/** Something that can be cancelled, like a scheduled task. */
fun interface Cancellable {
  fun cancel()
}

/** Runs tasks later on the mux's own thread. */
fun interface Scheduler {
  fun schedule(delayMs: Long, task: () -> Unit): Cancellable
}

/** What a destination socket tells the mux. Called on the mux's thread. */
interface SocketEvents {
  fun onData(chunk: ByteArray)

  /** The destination finished sending. */
  fun onEnd()

  fun onError(error: Throwable)

  /** The socket is fully closed. */
  fun onClose(hadError: Boolean)
}

/**
 * A destination connection as the mux drives it, modelled on a Node socket: paused until
 * resumed, writes complete asynchronously, and events arrive on the mux's thread.
 */
interface MuxSocket {
  fun start(events: SocketEvents)

  /** Queue [chunk]; [onWritten] runs on the mux's thread once it's written. */
  fun write(chunk: ByteArray, onWritten: () -> Unit)

  /** Finish writing (after what's queued), keeping the read side open. */
  fun end()

  fun destroy()

  fun pause()

  fun resume()

  val isPaused: Boolean
}

/** A cancellation flag with listeners, for a connection being made. */
class CancelSignal {
  @Volatile
  var cancelled = false
    private set

  private val listeners = mutableListOf<() -> Unit>()

  fun onCancel(listener: () -> Unit) {
    val runNow =
      synchronized(listeners) {
        if (!cancelled) listeners.add(listener)
        cancelled
      }
    if (runNow) listener()
  }

  fun cancel() {
    val toRun =
      synchronized(listeners) {
        if (cancelled) return
        cancelled = true
        listeners.toList().also { listeners.clear() }
      }
    toRun.forEach { it() }
  }
}

/** Opens the real connections. */
fun interface Connector {
  /**
   * Connect to [host]:[port], or fail with a reason. [done] must be called exactly once, on the
   * mux's thread. [cancel] fires when the stream is reset before the connection is made.
   */
  fun connect(host: String, port: Int, cancel: CancelSignal, done: (Result<MuxSocket>) -> Unit)
}

data class MuxStats(val openStreams: Int, val bytesIn: Long, val bytesOut: Long)

/**
 * The agent side of the egress multiplexer: connects the computer's streams to the internet.
 * The same behavior as the TypeScript `Mux` in the agent role, which
 * `test-vectors/mux-scenarios.json` checks step by step.
 *
 * Not thread-safe: every call, and every callback from sockets, the connector and the scheduler,
 * must happen on one thread.
 *
 * Flow control has three layers. Each stream may have at most [INITIAL_WINDOW] bytes
 * uncredited; the whole mux at most [MAX_IN_FLIGHT]; and reading stops while the transport
 * itself holds more than [TRANSPORT_HIGH_WATER]. `Window` and control frames are never held
 * back, so the other side always progresses.
 */
class AgentMux(
  private val send: (ByteArray) -> Unit,
  private val connector: Connector,
  private val scheduler: Scheduler,
  /** Bytes the transport holds that it hasn't sent yet (OkHttp's `queueSize()`). */
  private val transportBuffered: () -> Long = { 0L },
  private val maxStreams: Int = MAX_STREAMS,
) {
  private class Stream(val id: Long) {
    var socket: MuxSocket? = null
    /** Data that arrived before the socket was attached. */
    val pending = mutableListOf<ByteArray>()
    var sendWindow = INITIAL_WINDOW
    /** Data sent on this stream that the other side hasn't credited yet. */
    var uncredited = 0L
    /** Whether this stream's socket is paused for flow control. */
    var paused = false
    var localEnded = false
    var remoteEnded = false
    var closed = false
    /** Aborts the connection being made for this stream. */
    var connecting: CancelSignal? = null
  }

  private val streams = LinkedHashMap<Long, Stream>()
  private var bytesIn = 0L
  private var bytesOut = 0L
  private var inFlight = 0L
  private var pressured = false
  private var poll: Cancellable? = null

  val stats: MuxStats
    get() = MuxStats(streams.size, bytesIn, bytesOut)

  /** Data sent but not yet credited, across every stream. */
  val uncredited: Long
    get() = inFlight

  /** Handle one binary frame from the relay. Throws [MalformedFrameException] for a bad one. */
  fun handleFrame(data: ByteArray) {
    val frame = Frames.decode(data)
    val stream = streams[frame.streamId]
    when (frame.type) {
      FrameType.OPEN -> onRemoteOpen(frame.streamId, frame.payload)
      FrameType.OPEN_OK -> Unit // Only the computer side waits for these.
      FrameType.OPEN_FAIL -> if (stream != null) destroy(stream, notifyRemote = false)
      FrameType.DATA -> {
        // Like TCP, data for a connection that's gone is refused, so the sender stops waiting.
        if (stream == null) send(Frames.encode(FrameType.RESET, frame.streamId))
        if (stream == null || stream.closed) return
        bytesIn += frame.payload.size
        if (stream.socket != null) writeLocal(stream, frame.payload) else stream.pending.add(frame.payload)
      }
      FrameType.END -> {
        if (stream == null) return
        stream.remoteEnded = true
        stream.socket?.end()
        maybeFinish(stream)
      }
      FrameType.RESET -> if (stream != null) destroy(stream, notifyRemote = false)
      FrameType.WINDOW -> {
        if (stream == null || frame.payload.size < 4) return
        val granted = Frames.readU32(frame.payload, 0)
        val credit = minOf(granted, stream.uncredited)
        stream.sendWindow += granted
        stream.uncredited -= credit
        inFlight -= credit
        updatePressure()
        applyFlow(stream)
      }
    }
  }

  /** Drop every stream, for example when the computer side of the tunnel goes away. */
  fun resetAll() {
    for (stream in streams.values.toList()) destroy(stream, notifyRemote = false)
    stopPolling()
  }

  private fun createStream(id: Long): Stream = Stream(id).also { streams[id] = it }

  private fun onRemoteOpen(id: Long, payload: ByteArray) {
    if (streams.containsKey(id)) {
      send(Frames.encode(FrameType.OPEN_FAIL, id, "Stream id already in use"))
      return
    }
    val target = parseTarget(payload)
    if (target == null) {
      send(Frames.encode(FrameType.OPEN_FAIL, id, "Malformed open request"))
      return
    }
    if (streams.size >= maxStreams) {
      send(Frames.encode(FrameType.OPEN_FAIL, id, "Too many connections on this phone"))
      return
    }
    val stream = createStream(id)
    val connecting = CancelSignal()
    stream.connecting = connecting
    connector.connect(target.first, target.second, connecting) { result ->
      stream.connecting = null
      result.fold(
        onSuccess = { socket ->
          // Reset (or replaced) while connecting: the other side has already moved on.
          if (stream.closed || streams[id] !== stream) {
            socket.destroy()
          } else {
            send(Frames.encode(FrameType.OPEN_OK, id))
            attach(stream, socket)
          }
        },
        onFailure = { error ->
          if (!stream.closed && streams[id] === stream) {
            stream.closed = true
            streams.remove(id)
            send(Frames.encode(FrameType.OPEN_FAIL, id, error.message ?: "Connection failed"))
          }
        },
      )
    }
  }

  /** `{ host, port }` with a string host and a numeric port, as the TypeScript side accepts. */
  private fun parseTarget(payload: ByteArray): Pair<String, Int>? =
    try {
      val json = JSONObject(String(payload, Charsets.UTF_8))
      val host = json.opt("host") as? String
      val port = json.opt("port") as? Number
      if (host == null || port == null) null
      else {
        val value = port.toDouble()
        // A port that isn't a whole number in range can't be connected; the connector refuses it.
        Pair(host, if (value == Math.floor(value) && value in 0.0..65_535.0) value.toInt() else -1)
      }
    } catch (_: Exception) {
      null
    }

  private fun attach(stream: Stream, socket: MuxSocket) {
    stream.socket = socket
    socket.start(
      object : SocketEvents {
        override fun onData(chunk: ByteArray) = onLocalData(stream, chunk)

        override fun onEnd() {
          stream.localEnded = true
          send(Frames.encode(FrameType.END, stream.id))
          maybeFinish(stream)
        }

        override fun onError(error: Throwable) = destroy(stream, notifyRemote = true)

        override fun onClose(hadError: Boolean) {
          // After a clean end (a server closing once it has responded) the End frame already
          // tells the other side, which still has to write what it received. A reset would drop it.
          if (stream.localEnded && !hadError) forget(stream)
          else destroy(stream, notifyRemote = !(stream.localEnded && stream.remoteEnded))
        }
      }
    )
    for (chunk in stream.pending) writeLocal(stream, chunk)
    stream.pending.clear()
    if (stream.remoteEnded) socket.end()
    applyFlow(stream)
  }

  private fun onLocalData(stream: Stream, chunk: ByteArray) {
    var offset = 0
    while (offset < chunk.size) {
      val end = minOf(chunk.size, offset + MAX_FRAME_PAYLOAD)
      val part = chunk.copyOfRange(offset, end)
      send(Frames.encode(FrameType.DATA, stream.id, part))
      bytesOut += part.size
      stream.sendWindow -= part.size
      stream.uncredited += part.size
      inFlight += part.size
      offset = end
    }
    updatePressure()
    applyFlow(stream)
  }

  private fun writeLocal(stream: Stream, chunk: ByteArray) {
    val socket = stream.socket ?: return
    val length = chunk.size.toLong()
    socket.write(chunk) { if (!stream.closed) send(Frames.window(stream.id, length)) }
  }

  /** Pause or resume one stream's socket, from its own window and the mux's pressure. */
  private fun applyFlow(stream: Stream) {
    val socket = stream.socket ?: return
    if (stream.closed) return
    val shouldPause = pressured || stream.sendWindow <= 0
    if (shouldPause && !stream.paused) {
      stream.paused = true
      socket.pause()
    } else if (!shouldPause && (stream.paused || socket.isPaused)) {
      stream.paused = false
      socket.resume()
    }
  }

  /** Recompute whether the whole mux must stop reading, and apply it to every stream. */
  private fun updatePressure() {
    val buffered = transportBuffered()
    val transportFull =
      if (pressured) buffered > TRANSPORT_LOW_WATER else buffered > TRANSPORT_HIGH_WATER
    val next = inFlight > MAX_IN_FLIGHT || transportFull
    if (transportFull) startPolling() else stopPolling()
    if (next == pressured) return
    pressured = next
    for (stream in streams.values.toList()) applyFlow(stream)
  }

  private fun startPolling() {
    if (poll != null) return
    poll = scheduler.schedule(TRANSPORT_POLL_MS) { pollTransport() }
  }

  private fun pollTransport() {
    poll = null
    updatePressure()
  }

  private fun stopPolling() {
    poll?.cancel()
    poll = null
  }

  private fun maybeFinish(stream: Stream) {
    if (stream.localEnded && stream.remoteEnded) forget(stream)
  }

  /** Stop tracking a stream whose socket is gone, leaving the other side to finish on its own. */
  private fun forget(stream: Stream) {
    if (stream.closed && streams[stream.id] !== stream) return
    stream.closed = true
    if (streams[stream.id] === stream) streams.remove(stream.id)
    release(stream)
  }

  /** Close a stream for good: cancel its connect, drop its socket. */
  private fun destroy(stream: Stream, notifyRemote: Boolean) {
    if (stream.closed && streams[stream.id] !== stream) return
    stream.closed = true
    if (streams[stream.id] === stream) streams.remove(stream.id)
    stream.connecting?.cancel()
    stream.connecting = null
    if (notifyRemote) send(Frames.encode(FrameType.RESET, stream.id))
    stream.socket?.destroy()
    release(stream)
  }

  /** A gone stream's uncredited data no longer counts against the mux. */
  private fun release(stream: Stream) {
    if (stream.uncredited == 0L) return
    inFlight -= stream.uncredited
    stream.uncredited = 0
    updatePressure()
  }
}
