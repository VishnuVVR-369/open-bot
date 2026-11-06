package dev.openbot.egress.core

/**
 * Binary framing for the egress tunnel, as in `packages/egress/src/frames.ts`.
 *
 * Every binary websocket message is one frame: `[type u8][streamId u32 BE][payload]`.
 * Text websocket messages carry JSON control messages (see [Control]).
 */
object FrameType {
  /** Open a TCP connection. Payload: UTF-8 JSON `{ host, port }`. Sent by the computer side. */
  const val OPEN = 1
  /** The connection was opened. No payload. */
  const val OPEN_OK = 2
  /** The connection could not be opened. Payload: UTF-8 reason. */
  const val OPEN_FAIL = 3
  /** Stream bytes. */
  const val DATA = 4
  /** The sender finished writing (half close). */
  const val END = 5
  /** Abort the stream immediately in both directions. */
  const val RESET = 6
  /** Flow control credit. Payload: u32 BE number of bytes the receiver consumed. */
  const val WINDOW = 7
}

class Frame(val type: Int, val streamId: Long, val payload: ByteArray)

class MalformedFrameException(message: String) : IllegalArgumentException(message)

object Frames {
  const val HEADER_BYTES = 5
  const val MAX_STREAM_ID = 0xFFFF_FFFFL

  /**
   * The `OpenFail` reason the worker's relay sends when no device can take a stream. The
   * computer side may route it again; any other reason is about the destination itself.
   */
  const val AGENT_GONE = "AGENT_GONE"

  private val EMPTY = ByteArray(0)

  fun encode(type: Int, streamId: Long, payload: ByteArray = EMPTY): ByteArray {
    require(streamId in 0..MAX_STREAM_ID) { "Stream id out of range: $streamId" }
    val frame = ByteArray(HEADER_BYTES + payload.size)
    frame[0] = type.toByte()
    writeU32(frame, 1, streamId)
    payload.copyInto(frame, HEADER_BYTES)
    return frame
  }

  fun encode(type: Int, streamId: Long, text: String): ByteArray =
    encode(type, streamId, text.toByteArray(Charsets.UTF_8))

  fun decode(data: ByteArray): Frame {
    if (data.size < HEADER_BYTES) throw MalformedFrameException("Egress frame too short (${data.size} bytes)")
    val type = data[0].toInt() and 0xff
    if (type < FrameType.OPEN || type > FrameType.WINDOW) throw MalformedFrameException("Unknown egress frame type $type")
    return Frame(type, readU32(data, 1), data.copyOfRange(HEADER_BYTES, data.size))
  }

  fun window(streamId: Long, bytes: Long): ByteArray {
    val payload = ByteArray(4)
    writeU32(payload, 0, bytes)
    return encode(FrameType.WINDOW, streamId, payload)
  }

  fun readU32(bytes: ByteArray, offset: Int): Long =
    ((bytes[offset].toLong() and 0xff) shl 24) or
      ((bytes[offset + 1].toLong() and 0xff) shl 16) or
      ((bytes[offset + 2].toLong() and 0xff) shl 8) or
      (bytes[offset + 3].toLong() and 0xff)

  private fun writeU32(bytes: ByteArray, offset: Int, value: Long) {
    bytes[offset] = (value ushr 24).toByte()
    bytes[offset + 1] = (value ushr 16).toByte()
    bytes[offset + 2] = (value ushr 8).toByte()
    bytes[offset + 3] = value.toByte()
  }
}
