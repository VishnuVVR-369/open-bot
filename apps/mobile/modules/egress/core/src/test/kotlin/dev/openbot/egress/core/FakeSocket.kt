package dev.openbot.egress.core

/** A destination socket the test drives by hand, recording what the mux does to it. */
class FakeSocket(private val completeWrites: Boolean = false) : MuxSocket {
  val writes = mutableListOf<ByteArray>()
  private val callbacks = mutableListOf<() -> Unit>()
  var ended = false
  var destroyed = false
  var paused = false
  lateinit var events: SocketEvents

  override fun start(events: SocketEvents) {
    this.events = events
  }

  override fun write(chunk: ByteArray, onWritten: () -> Unit) {
    writes.add(chunk.copyOf())
    if (completeWrites) onWritten() else callbacks.add(onWritten)
  }

  /** Finish the writes so far (the mux credits the other side as each finishes). */
  fun flush() {
    val pending = callbacks.toList()
    callbacks.clear()
    pending.forEach { it() }
  }

  override fun end() {
    ended = true
  }

  override fun destroy() {
    destroyed = true
  }

  override fun pause() {
    paused = true
  }

  override fun resume() {
    paused = false
  }

  override val isPaused: Boolean
    get() = paused
}

/** A connector whose connections the test completes, in order. */
class FakeConnector(private val completeWrites: Boolean = false) : Connector {
  class Pending(val host: String, val port: Int, val cancel: CancelSignal, val done: (Result<MuxSocket>) -> Unit)

  val pending = ArrayDeque<Pending>()
  val sockets = mutableListOf<FakeSocket>()

  override fun connect(host: String, port: Int, cancel: CancelSignal, done: (Result<MuxSocket>) -> Unit) {
    pending.addLast(Pending(host, port, cancel, done))
  }

  fun succeed(): FakeSocket {
    val socket = FakeSocket(completeWrites)
    sockets.add(socket)
    pending.removeFirst().done(Result.success(socket))
    return socket
  }

  fun fail(reason: String) = pending.removeFirst().done(Result.failure(Exception(reason)))

  fun succeedAll() {
    while (pending.isNotEmpty()) succeed()
  }
}
