package dev.openbot.egress.core

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketAddress
import javax.net.SocketFactory
import kotlin.concurrent.thread

/**
 * An [Egress] for tests: names resolve to a public address (which the policy allows), and every
 * connection actually goes to a local server, so nothing leaves the machine.
 */
class LocalEgress(private val port: () -> Int, private val answers: List<String> = listOf("93.184.215.14")) : Egress {
  val connectedTo = mutableListOf<SocketAddress>()

  override val socketFactory: SocketFactory =
    object : SocketFactory() {
      override fun createSocket(): Socket =
        object : Socket() {
          override fun connect(endpoint: SocketAddress, timeout: Int) {
            synchronized(connectedTo) { connectedTo.add(endpoint) }
            super.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), port()), timeout)
          }
        }

      override fun createSocket(host: String, port: Int) = unsupported()

      override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) = unsupported()

      override fun createSocket(host: InetAddress, port: Int) = unsupported()

      override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int) = unsupported()

      private fun unsupported(): Socket = throw UnsupportedOperationException()
    }

  override fun lookup(host: String): List<InetAddress> = answers.map { InetAddress.getByName(it) }

  override val nat64: List<Nat64Prefix> = emptyList()
}

/** A local TCP server that hands each connection to [handle] on its own thread. */
class LocalServer(private val handle: (Socket) -> Unit) : AutoCloseable {
  private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
  private val clients = mutableListOf<Socket>()
  val port: Int get() = server.localPort

  init {
    thread(isDaemon = true, name = "local-server") {
      while (!server.isClosed) {
        val client =
          try {
            server.accept()
          } catch (_: Exception) {
            break
          }
        synchronized(clients) { clients.add(client) }
        thread(isDaemon = true) {
          try {
            handle(client)
          } catch (_: Exception) {}
        }
      }
    }
  }

  override fun close() {
    server.close()
    synchronized(clients) { clients.forEach { it.close() } }
  }

  companion object {
    /** Echoes everything back, and finishes when the client does. */
    fun echo() =
      LocalServer { socket ->
        socket.use {
          val input = it.getInputStream()
          val output = it.getOutputStream()
          val buffer = ByteArray(16 * 1024)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            output.flush()
          }
        }
      }
  }
}

/** The agent's thread and a pool for blocking IO, closed after a test. */
class Threads : AutoCloseable {
  val mux = EgressAgent.newExecutor()
  val io = newIoPool()
  val scheduler = mux.asScheduler()

  /** Run [block] on the mux's thread and wait for its result. */
  fun <T> onMux(block: () -> T): T = mux.submit(block).get()

  override fun close() {
    mux.shutdownNow()
    io.shutdownNow()
  }
}
