/**
 * Binary framing for the egress tunnel.
 *
 * Every binary websocket message is one frame: `[type u8][streamId u32 BE][payload]`.
 * Text websocket messages carry JSON control messages (see `ControlMessage`).
 */

export const FrameType = {
  /** Open a TCP connection. Payload: UTF-8 JSON `{ host, port }`. Sent by the computer side. */
  Open: 1,
  /** The connection was opened. No payload. Sent by the agent side. */
  OpenOk: 2,
  /** The connection could not be opened. Payload: UTF-8 reason. */
  OpenFail: 3,
  /** Stream bytes. */
  Data: 4,
  /** The sender finished writing (half close). */
  End: 5,
  /** Abort the stream immediately in both directions. */
  Reset: 6,
  /** Flow control credit. Payload: u32 BE number of bytes the receiver consumed. */
  Window: 7,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}

const HEADER_BYTES = 5;

export function encodeFrame(type: FrameType, streamId: number, payload?: Buffer | string): Buffer {
  const body =
    payload === undefined
      ? Buffer.alloc(0)
      : typeof payload === "string"
        ? Buffer.from(payload, "utf8")
        : payload;
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(streamId, 1);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

export function decodeFrame(data: Buffer): Frame {
  if (data.length < HEADER_BYTES) {
    throw new Error(`Egress frame too short (${data.length} bytes)`);
  }
  const type = data.readUInt8(0);
  if (type < FrameType.Open || type > FrameType.Window) {
    throw new Error(`Unknown egress frame type ${type}`);
  }
  return {
    type: type as FrameType,
    streamId: data.readUInt32BE(1),
    payload: data.subarray(HEADER_BYTES),
  };
}

export function encodeWindow(streamId: number, bytes: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32BE(bytes, 0);
  return encodeFrame(FrameType.Window, streamId, payload);
}

export type EgressMode = "off" | "prefer" | "require";

/** JSON control messages exchanged as text websocket messages. */
export type ControlMessage =
  /** Worker to computer: the current egress mode and whether a desktop agent is connected. */
  | { type: "config"; mode: EgressMode; agentOnline: boolean }
  /** Worker to agent: the computer side of the tunnel went away, so drop every stream. */
  | { type: "peer-down" }
  /** Worker to agent: the computer side is connected. */
  | { type: "peer-up" }
  /** Agent to worker: periodic counters for the settings page. */
  | { type: "stats"; openStreams: number; bytesIn: number; bytesOut: number };

export function parseControlMessage(text: string): ControlMessage | null {
  try {
    const value = JSON.parse(text) as { type?: unknown };
    if (typeof value !== "object" || value === null || typeof value.type !== "string") return null;
    return value as ControlMessage;
  } catch {
    return null;
  }
}
