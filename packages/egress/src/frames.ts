/**
 * Binary framing for the egress tunnel.
 *
 * Every binary websocket message is one frame: `[type u8][streamId u32 BE][payload]`.
 * Text websocket messages carry JSON control messages (see `ControlMessage`).
 */

// The egress mode, the phone mode and the phone's unavailable reasons are settings and API values
// too, so `@open-bot/domain` defines them once; the test vectors carry them to the Kotlin agent.
import {
  EGRESS_MODES,
  PHONE_MODES,
  UNAVAILABLE_REASONS,
  type EgressMode,
  type PhoneMode,
  type UnavailableReason,
} from "@open-bot/domain";

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

/**
 * The `OpenFail` reason the worker's relay sends when no device can take a stream (none is
 * connected, or the one carrying it went away while it was opening). The computer side may try
 * the connection again another way; any other reason is about the destination itself.
 */
export const AGENT_GONE = "AGENT_GONE";

/**
 * What the relay wants from an agent: carry new connections, carry only the ones it already has,
 * or disconnect (a phone then stops its foreground service; the Mac ignores it).
 */
export const AGENT_ROLES = ["active", "standby", "release"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** JSON control messages exchanged as text websocket messages. */
export type ControlMessage =
  /**
   * Worker to computer: the egress mode and whether a device carries new connections.
   * `wakeable`: a phone could be woken, so connections that need one should wait for it.
   * `holdMs`: a phone is being woken now, so hold new connections for up to this long.
   */
  | { type: "config"; mode: EgressMode; agentOnline: boolean; wakeable?: boolean; holdMs?: number }
  /** Computer to worker: a screen is starting or being taken for a run or you, so browsing is near. */
  | { type: "demand"; screenId: string }
  /** Worker to agent: the computer side of the tunnel went away, so drop every stream. */
  | { type: "peer-down" }
  /** Worker to agent: the computer side is connected. */
  | { type: "peer-up" }
  /** Worker to agent: what this agent should do now. */
  | { type: "role"; role: AgentRole }
  /** Worker to a phone: the server's phone mode, which the phone remembers for reboots. */
  | { type: "policy"; phoneMode: PhoneMode }
  /** Agent to worker: periodic counters for the settings page. */
  | { type: "stats"; openStreams: number; bytesIn: number; bytesOut: number }
  /**
   * Phone to worker: it is about to disconnect because it can't carry traffic, and why. `seq`
   * numbers the phone's reports (here and through the device route), so one that arrives late
   * can be told apart from a new one.
   */
  | { type: "unavailable"; reason: UnavailableReason; seq?: number }
  /** Phone to worker, once connected: it carries traffic again, so its reports up to `seq` are over. */
  | { type: "available"; seq: number };

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * Parse a control message, or `null` for anything malformed or unknown, so each side can ignore
 * messages from newer versions of the other.
 */
export function parseControlMessage(text: string): ControlMessage | null {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (value.type) {
    case "config": {
      if (!isOneOf(EGRESS_MODES, value.mode) || typeof value.agentOnline !== "boolean") return null;
      if (value.wakeable !== undefined && typeof value.wakeable !== "boolean") return null;
      if (value.holdMs !== undefined && !isCount(value.holdMs)) return null;
      return {
        type: "config",
        mode: value.mode,
        agentOnline: value.agentOnline,
        ...(value.wakeable === undefined ? {} : { wakeable: value.wakeable }),
        ...(value.holdMs === undefined ? {} : { holdMs: value.holdMs }),
      };
    }
    case "demand":
      return typeof value.screenId === "string" && value.screenId.length > 0
        ? { type: "demand", screenId: value.screenId }
        : null;
    case "peer-down":
    case "peer-up":
      return { type: value.type };
    case "role":
      return isOneOf(AGENT_ROLES, value.role) ? { type: "role", role: value.role } : null;
    case "policy":
      return isOneOf(PHONE_MODES, value.phoneMode)
        ? { type: "policy", phoneMode: value.phoneMode }
        : null;
    case "stats":
      return isCount(value.openStreams) && isCount(value.bytesIn) && isCount(value.bytesOut)
        ? {
            type: "stats",
            openStreams: value.openStreams,
            bytesIn: value.bytesIn,
            bytesOut: value.bytesOut,
          }
        : null;
    case "unavailable":
      if (!isOneOf(UNAVAILABLE_REASONS, value.reason)) return null;
      if (value.seq !== undefined && !isCount(value.seq)) return null;
      return {
        type: "unavailable",
        reason: value.reason,
        ...(value.seq === undefined ? {} : { seq: value.seq }),
      };
    case "available":
      return isCount(value.seq) ? { type: "available", seq: value.seq } : null;
    default:
      return null;
  }
}
