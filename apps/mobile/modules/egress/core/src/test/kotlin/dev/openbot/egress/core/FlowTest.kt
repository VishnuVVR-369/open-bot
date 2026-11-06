package dev.openbot.egress.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The mux's flow control, as `flow.test.ts` checks it on the TypeScript side. */
class FlowTest {
  private class AgentSide(streams: Int) {
    val sent = mutableListOf<ByteArray>()
    val connector = FakeConnector(completeWrites = true)
    val scheduler = FakeScheduler()
    var buffered = 0L
    val mux = AgentMux({ sent.add(it) }, connector, scheduler, transportBuffered = { buffered })

    init {
      for (index in 0 until streams)
        mux.handleFrame(Frames.encode(FrameType.OPEN, index * 2L + 1, """{"host":"example.com","port":443}"""))
      connector.succeedAll()
    }

    val sockets get() = connector.sockets
  }

  @Test
  fun `pauses every stream once too much is in flight, and resumes with credit`() {
    val streams = (MAX_IN_FLIGHT / INITIAL_WINDOW + 1).toInt()
    val side = AgentSide(streams)
    val chunk = ByteArray(MAX_FRAME_PAYLOAD)
    // Every stream sends half its window: nothing pauses for its own window.
    for (socket in side.sockets) repeat((INITIAL_WINDOW / 2 / chunk.size).toInt()) { socket.events.onData(chunk) }
    assertEquals(streams * INITIAL_WINDOW / 2, side.mux.uncredited)
    assertTrue(side.sockets.none { it.paused })
    for (socket in side.sockets)
      repeat((INITIAL_WINDOW / 2 / chunk.size - 1).toInt()) { socket.events.onData(chunk) }
    assertTrue(side.mux.uncredited > MAX_IN_FLIGHT)
    assertTrue(side.sockets.all { it.paused })
    side.mux.handleFrame(Frames.window(1, INITIAL_WINDOW))
    assertTrue(side.mux.uncredited <= MAX_IN_FLIGHT)
    assertTrue(side.sockets.none { it.paused })
  }

  @Test
  fun `stops reading while the transport is backed up and resumes when it drains, with no new sends`() {
    val side = AgentSide(MAX_STREAMS)
    side.buffered = TRANSPORT_HIGH_WATER + 1
    side.sockets[0].events.onData("x".toByteArray())
    assertTrue(side.sockets.all { it.paused })
    // Credit still flows while paused: writes to a destination are acknowledged.
    val before = side.sent.size
    side.mux.handleFrame(Frames.encode(FrameType.DATA, 3, "payload"))
    assertEquals(before + 1, side.sent.size)
    assertEquals(FrameType.WINDOW, Frames.decode(side.sent.last()).type)
    // Still above the low-water mark: stays paused.
    side.buffered = TRANSPORT_LOW_WATER + 1
    side.scheduler.advance(TRANSPORT_POLL_MS * 3)
    assertTrue(side.sockets.all { it.paused })
    side.buffered = 0
    side.scheduler.advance(TRANSPORT_POLL_MS + 10)
    assertTrue(side.sockets.none { it.paused })
  }

  @Test
  fun `refuses more streams than the phone carries`() {
    val side = AgentSide(MAX_STREAMS)
    side.mux.handleFrame(Frames.encode(FrameType.OPEN, 9_999, """{"host":"example.com","port":443}"""))
    val refusal = Frames.decode(side.sent.last())
    assertEquals(FrameType.OPEN_FAIL, refusal.type)
    assertEquals(9_999L, refusal.streamId)
    assertEquals(MAX_STREAMS, side.mux.stats.openStreams)
  }

  @Test
  fun `cancels the connection when the stream is reset while connecting`() {
    val sent = mutableListOf<ByteArray>()
    val connector = FakeConnector()
    val mux = AgentMux({ sent.add(it) }, connector, FakeScheduler())
    mux.handleFrame(Frames.encode(FrameType.OPEN, 1, """{"host":"example.com","port":443}"""))
    mux.handleFrame(Frames.encode(FrameType.RESET, 1))
    assertTrue(connector.pending.single().cancel.cancelled)
    assertTrue(sent.isEmpty())
  }
}
