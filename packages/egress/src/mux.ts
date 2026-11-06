import type { Socket } from "node:net";
import { AGENT_GONE, decodeFrame, encodeFrame, encodeWindow, FrameType } from "./frames";

/** Bytes a side may send on one stream before the receiver grants more credit. */
export const INITIAL_WINDOW = 1024 * 1024;
/** The most stream data a side keeps sent but not yet credited, across all its streams. */
export const MAX_IN_FLIGHT = 8 * 1024 * 1024;
/** Above this many bytes waiting in the transport (the websocket), reading stops... */
export const TRANSPORT_HIGH_WATER = 4 * 1024 * 1024;
/** ...and resumes below this many. */
export const TRANSPORT_LOW_WATER = 1024 * 1024;
export const MAX_FRAME_PAYLOAD = 64 * 1024;
const OPEN_TIMEOUT_MS = 20_000;
/** How often to check a transport that has no drain event, while it's too full. */
const TRANSPORT_POLL_MS = 50;

export type MuxRole = "computer" | "agent";

export interface MuxOptions {
  role: MuxRole;
  send: (frame: Buffer) => void;
  /**
   * Agent side only: open the real connection for a stream, or throw with a reason.
   * `signal` aborts when the stream is reset or times out before the connection is made.
   */
  connect?: (host: string, port: number, signal: AbortSignal) => Promise<Socket>;
  /** Bytes the transport holds that it hasn't sent yet, like a websocket's `bufferedAmount`. */
  transportBuffered?: () => number;
}

/** Why opening a stream failed. `agentGone` means no device could carry it, so try another way. */
export class OpenError extends Error {
  constructor(
    message: string,
    readonly agentGone = false,
  ) {
    super(message);
    this.name = "OpenError";
  }
}

interface Stream {
  id: number;
  socket: Socket | null;
  /** Data that arrived before a socket was attached. */
  pending: Buffer[];
  sendWindow: number;
  /** Data sent on this stream that the other side hasn't credited yet. */
  uncredited: number;
  /** Whether this stream's socket is paused for flow control. */
  paused: boolean;
  localEnded: boolean;
  remoteEnded: boolean;
  closed: boolean;
  /** Computer side: a pending `open`. */
  open?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  /** Agent side: aborts the connection being made for this stream. */
  connecting?: AbortController;
}

export interface MuxStats {
  openStreams: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Multiplexes many TCP streams over one message channel, with flow control per stream and across
 * all of them.
 *
 * The computer side opens streams (odd ids) and the agent side connects them to the internet.
 *
 * Flow control has three layers. Each stream may have at most `INITIAL_WINDOW` bytes uncredited.
 * The whole mux may have at most `MAX_IN_FLIGHT` uncredited, which bounds what any hop in between
 * (the worker's relay) ever buffers. And reading stops while the transport itself is backed up.
 * Credit (`Window`) and control frames are never held back, so the other side always progresses.
 */
export class Mux {
  private readonly streams = new Map<number, Stream>();
  private nextId: number;
  private bytesIn = 0;
  private bytesOut = 0;
  private inFlight = 0;
  private pressured = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: MuxOptions) {
    this.nextId = options.role === "computer" ? 1 : 2;
  }

  get stats(): MuxStats {
    return { openStreams: this.streams.size, bytesIn: this.bytesIn, bytesOut: this.bytesOut };
  }

  /** Data sent but not yet credited, across every stream. */
  get uncredited(): number {
    return this.inFlight;
  }

  /**
   * Computer side: ask the agent to open a connection. Resolves with the stream id once it's open.
   * `deadline` (epoch ms) caps the wait, so a caller with its own time limit isn't kept past it.
   */
  open(host: string, port: number, options: { deadline?: number } = {}): Promise<number> {
    const id = this.nextId;
    this.nextId += 2;
    const stream = this.createStream(id);
    const wait = Math.max(
      0,
      Math.min(OPEN_TIMEOUT_MS, (options.deadline ?? Infinity) - Date.now()),
    );
    return new Promise<number>((resolve, reject) => {
      stream.open = {
        resolve: () => resolve(id),
        reject,
        timer: setTimeout(() => {
          // A reset makes the other side give up on the connection it's still making.
          this.destroy(stream, true, new OpenError("Timed out opening the connection"));
        }, wait),
      };
      this.options.send(encodeFrame(FrameType.Open, id, JSON.stringify({ host, port })));
    });
  }

  /** Bridge a local socket to an open stream. */
  attach(streamId: number, socket: Socket): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) {
      socket.destroy();
      return;
    }
    stream.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onLocalData(stream, chunk));
    socket.on("end", () => {
      stream.localEnded = true;
      this.options.send(encodeFrame(FrameType.End, stream.id));
      this.maybeFinish(stream);
    });
    socket.on("error", () => this.destroy(stream, true));
    socket.on("close", (hadError: boolean) => {
      // After a clean end (a server closing once it has responded) the End frame already tells
      // the other side, which still has to write what it received. A reset would drop that.
      if (stream.localEnded && !hadError) this.forget(stream);
      else this.destroy(stream, !(stream.localEnded && stream.remoteEnded));
    });
    for (const chunk of stream.pending) this.writeLocal(stream, chunk);
    stream.pending = [];
    if (stream.remoteEnded) socket.end();
    this.applyFlow(stream);
  }

  /** Abort one stream in both directions, for example when its local client left meanwhile. */
  reset(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (stream) this.destroy(stream, true);
  }

  handleFrame(data: Buffer): void {
    const frame = decodeFrame(data);
    const stream = this.streams.get(frame.streamId);
    switch (frame.type) {
      case FrameType.Open:
        void this.onRemoteOpen(frame.streamId, frame.payload);
        return;
      case FrameType.OpenOk:
        if (stream?.open) {
          clearTimeout(stream.open.timer);
          stream.open.resolve();
          stream.open = undefined;
        }
        return;
      case FrameType.OpenFail: {
        if (!stream) return;
        const reason = frame.payload.toString("utf8");
        this.destroy(
          stream,
          false,
          reason === AGENT_GONE
            ? new OpenError("No device could carry the connection", true)
            : new OpenError(reason || "Connection refused"),
        );
        return;
      }
      case FrameType.Data:
        // Like TCP, data for a connection that's gone is refused, so the sender stops waiting.
        if (!stream) this.options.send(encodeFrame(FrameType.Reset, frame.streamId));
        if (!stream || stream.closed) return;
        this.bytesIn += frame.payload.length;
        if (stream.socket) this.writeLocal(stream, frame.payload);
        else stream.pending.push(Buffer.from(frame.payload));
        return;
      case FrameType.End:
        if (!stream) return;
        stream.remoteEnded = true;
        stream.socket?.end();
        this.maybeFinish(stream);
        return;
      case FrameType.Reset:
        if (stream) this.destroy(stream, false, new OpenError("The connection was reset"));
        return;
      case FrameType.Window: {
        if (!stream || frame.payload.length < 4) return;
        const credit = Math.min(frame.payload.readUInt32BE(0), stream.uncredited);
        stream.sendWindow += frame.payload.readUInt32BE(0);
        stream.uncredited -= credit;
        this.inFlight -= credit;
        this.updatePressure();
        this.applyFlow(stream);
        return;
      }
    }
  }

  /**
   * Drop every stream, for example when the other side of the tunnel disconnects. Opens still
   * pending fail as `agentGone`: nothing carried them, so they may go another way.
   */
  resetAll(): void {
    for (const stream of [...this.streams.values()])
      this.destroy(stream, false, new OpenError("The tunnel closed", true));
    this.stopPolling();
  }

  private createStream(id: number): Stream {
    const stream: Stream = {
      id,
      socket: null,
      pending: [],
      sendWindow: INITIAL_WINDOW,
      uncredited: 0,
      paused: false,
      localEnded: false,
      remoteEnded: false,
      closed: false,
    };
    this.streams.set(id, stream);
    return stream;
  }

  private async onRemoteOpen(id: number, payload: Buffer): Promise<void> {
    if (!this.options.connect) {
      this.options.send(encodeFrame(FrameType.OpenFail, id, "This side does not open connections"));
      return;
    }
    if (this.streams.has(id)) {
      this.options.send(encodeFrame(FrameType.OpenFail, id, "Stream id already in use"));
      return;
    }
    let target: { host: string; port: number };
    try {
      target = JSON.parse(payload.toString("utf8")) as { host: string; port: number };
      if (typeof target.host !== "string" || typeof target.port !== "number")
        throw new Error("Malformed");
    } catch {
      this.options.send(encodeFrame(FrameType.OpenFail, id, "Malformed open request"));
      return;
    }
    const stream = this.createStream(id);
    const connecting = new AbortController();
    stream.connecting = connecting;
    try {
      const socket = await this.options.connect(target.host, target.port, connecting.signal);
      stream.connecting = undefined;
      // Reset (or replaced) while connecting: the other side has already moved on.
      if (stream.closed || this.streams.get(id) !== stream) {
        socket.destroy();
        return;
      }
      this.options.send(encodeFrame(FrameType.OpenOk, id));
      this.attach(id, socket);
    } catch (error) {
      stream.connecting = undefined;
      if (stream.closed || this.streams.get(id) !== stream) return;
      stream.closed = true;
      this.streams.delete(id);
      const reason = error instanceof Error ? error.message : "Connection failed";
      this.options.send(encodeFrame(FrameType.OpenFail, id, reason));
    }
  }

  private onLocalData(stream: Stream, chunk: Buffer): void {
    for (let offset = 0; offset < chunk.length; offset += MAX_FRAME_PAYLOAD) {
      const part = chunk.subarray(offset, offset + MAX_FRAME_PAYLOAD);
      this.options.send(encodeFrame(FrameType.Data, stream.id, part));
      this.bytesOut += part.length;
      stream.sendWindow -= part.length;
      stream.uncredited += part.length;
      this.inFlight += part.length;
    }
    this.updatePressure();
    this.applyFlow(stream);
  }

  private writeLocal(stream: Stream, chunk: Buffer): void {
    const socket = stream.socket;
    if (!socket || socket.destroyed) return;
    const length = chunk.length;
    socket.write(chunk, () => {
      if (!stream.closed) this.options.send(encodeWindow(stream.id, length));
    });
  }

  /** Pause or resume one stream's socket, from its own window and the mux's pressure. */
  private applyFlow(stream: Stream): void {
    const socket = stream.socket;
    if (!socket || stream.closed) return;
    const shouldPause = this.pressured || stream.sendWindow <= 0;
    if (shouldPause && !stream.paused) {
      stream.paused = true;
      socket.pause();
    } else if (!shouldPause && (stream.paused || socket.isPaused())) {
      stream.paused = false;
      socket.resume();
    }
  }

  /** Recompute whether the whole mux must stop reading, and apply it to every stream. */
  private updatePressure(): void {
    const buffered = this.options.transportBuffered?.() ?? 0;
    const transportFull = this.pressured
      ? buffered > TRANSPORT_LOW_WATER
      : buffered > TRANSPORT_HIGH_WATER;
    const next = this.inFlight > MAX_IN_FLIGHT || transportFull;
    if (transportFull) this.startPolling();
    else this.stopPolling();
    if (next === this.pressured) return;
    this.pressured = next;
    for (const stream of this.streams.values()) this.applyFlow(stream);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.updatePressure(), TRANSPORT_POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private maybeFinish(stream: Stream): void {
    if (stream.localEnded && stream.remoteEnded) this.forget(stream);
  }

  /** Stop tracking a stream whose socket is gone, leaving the other side to finish on its own. */
  private forget(stream: Stream): void {
    if (stream.closed && this.streams.get(stream.id) !== stream) return;
    stream.closed = true;
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
    this.release(stream);
  }

  /** Close a stream for good: settle its open, cancel its connect, drop its socket. */
  private destroy(stream: Stream, notifyRemote: boolean, reason?: OpenError): void {
    if (stream.closed && this.streams.get(stream.id) !== stream) return;
    stream.closed = true;
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
    if (stream.open) {
      clearTimeout(stream.open.timer);
      stream.open.reject(reason ?? new OpenError("The connection closed"));
      stream.open = undefined;
    }
    stream.connecting?.abort();
    stream.connecting = undefined;
    if (notifyRemote) this.options.send(encodeFrame(FrameType.Reset, stream.id));
    stream.socket?.destroy();
    this.release(stream);
  }

  /** A gone stream's uncredited data no longer counts against the mux. */
  private release(stream: Stream): void {
    if (stream.uncredited === 0) return;
    this.inFlight -= stream.uncredited;
    stream.uncredited = 0;
    this.updatePressure();
  }
}
