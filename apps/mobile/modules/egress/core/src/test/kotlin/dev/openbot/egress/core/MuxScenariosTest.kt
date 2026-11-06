package dev.openbot.egress.core

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * Drives [AgentMux] through the scenarios in `mux-scenarios.json`, which record what the
 * TypeScript mux sends and does to its sockets after every step, and expects the same.
 */
class MuxScenariosTest {
  private fun bytesOf(step: JSONObject): ByteArray {
    val fill = step.optJSONArray("fill")
    if (fill != null) return ByteArray(fill.getInt(0)) { fill.getInt(1).toByte() }
    return unhex(step.optString("payload", ""))
  }

  private fun recordFrame(data: ByteArray): Map<String, Any?> {
    val frame = Frames.decode(data)
    val base = mapOf<String, Any?>("type" to frame.type.toLong(), "streamId" to frame.streamId)
    return if (frame.payload.size <= 64) base + ("payload" to hex(frame.payload))
    else base + mapOf("length" to frame.payload.size.toLong(), "sha256" to sha256(frame.payload))
  }

  private fun recordWritten(written: ByteArray): Any =
    if (written.size <= 64) hex(written)
    else mapOf("length" to written.size.toLong(), "sha256" to sha256(written))

  @TestFactory
  fun scenarios(): List<DynamicTest> =
    Vectors.array("mux-scenarios.json").objects().map { scenario ->
      DynamicTest.dynamicTest(scenario.getString("name")) { run(scenario) }
    }

  private fun run(scenario: JSONObject) {
    val sent = mutableListOf<ByteArray>()
    val connector = FakeConnector()
    val mux = AgentMux(send = { sent.add(it) }, connector = connector, scheduler = FakeScheduler())
    for ((index, step) in scenario.getJSONArray("steps").objects().withIndex()) {
      val writtenBefore = connector.sockets.map { it.writes.size }
      val sockets = connector.sockets
      when (val op = step.getString("op")) {
        "frame" -> mux.handleFrame(Frames.encode(step.getInt("type"), step.getLong("streamId"), bytesOf(step)))
        "connect-ok" -> connector.succeed()
        "connect-fail" -> connector.fail(step.getString("reason"))
        "socket-data" -> sockets[step.getInt("socket")].events.onData(bytesOf(step))
        "socket-end" -> sockets[step.getInt("socket")].events.onEnd()
        "socket-close" -> sockets[step.getInt("socket")].events.onClose(step.getBoolean("hadError"))
        "socket-error" -> sockets[step.getInt("socket")].events.onError(Exception("boom"))
        "socket-flush" -> sockets[step.getInt("socket")].flush()
        "reset-all" -> mux.resetAll()
        else -> error("Unknown op $op")
      }
      val actual =
        mapOf(
          "frames" to sent.map(::recordFrame).also { sent.clear() },
          "sockets" to
            connector.sockets.mapIndexed { socketIndex, socket ->
              val written = socket.writes.drop(writtenBefore.getOrElse(socketIndex) { 0 })
              mapOf(
                "written" to recordWritten(written.fold(ByteArray(0)) { all, chunk -> all + chunk }),
                "ended" to socket.ended,
                "destroyed" to socket.destroyed,
                "paused" to socket.paused,
              )
            },
          "openStreams" to mux.stats.openStreams.toLong(),
          "uncredited" to mux.uncredited,
        )
      assertEquals(plain(step.getJSONObject("expect")), actual, "step $index (${step.getString("op")})")
    }
  }
}
