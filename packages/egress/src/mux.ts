import type { Socket } from "node:net";
import { decodeFrame, encodeFrame, encodeWindow, FrameType } from "./frames";

/** Bytes a side may send on one stream before the receiver grants more credit. */
export const INITIAL_WINDOW = 1024 * 1024;
const MAX_FRAME_PAYLOAD = 64 * 1024;
const OPEN_TIMEOUT_MS = 20_000;

export type MuxRole = "computer" | "agent";

export interface MuxOptions {
  role: MuxRole;
  send: (frame: Buffer) => void;
  /** Agent side only: open the real connection for a stream, or throw with a reason. */
  connect?: (host: string, port: number) => Promise<Socket>;
}

interface Stream {
  id: number;
  socket: Socket | null;
  /** Data that arrived before a socket was attached. */
  pending: Buffer[];
  sendWindow: number;
  paused: boolean;
  localEnded: boolean;
  remoteEnded: boolean;
  closed: boolean;
  open?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
}

export interface MuxStats {
  openStreams: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Multiplexes many TCP streams over one message channel, with per-stream flow control.
 *
 * The computer side opens streams (odd ids) and the agent side connects them to the internet.
 */
export class Mux {
  private readonly streams = new Map<number, Stream>();
  private nextId: number;
  private bytesIn = 0;
  private bytesOut = 0;

  constructor(private readonly options: MuxOptions) {
    this.nextId = options.role === "computer" ? 1 : 2;
  }

  get stats(): MuxStats {
    return { openStreams: this.streams.size, bytesIn: this.bytesIn, bytesOut: this.bytesOut };
  }

  /** Computer side: ask the agent to open a connection. Resolves with the stream id once it is open. */
  open(host: string, port: number): Promise<number> {
    const id = this.nextId;
    this.nextId += 2;
    const stream = this.createStream(id);
    return new Promise<number>((resolve, reject) => {
      stream.open = {
        resolve: () => resolve(id),
        reject,
        timer: setTimeout(() => {
          this.destroy(stream, true);
          reject(new Error("Timed out opening the connection through the desktop"));
        }, OPEN_TIMEOUT_MS),
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
    socket.on("close", () => this.destroy(stream, !(stream.localEnded && stream.remoteEnded)));
    for (const chunk of stream.pending) this.writeLocal(stream, chunk);
    stream.pending = [];
    if (stream.remoteEnded) socket.end();
    socket.resume();
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
      case FrameType.OpenFail:
        if (stream?.open) {
          clearTimeout(stream.open.timer);
          stream.open.reject(new Error(frame.payload.toString("utf8") || "Connection refused"));
          stream.open = undefined;
        }
        if (stream) this.destroy(stream, false);
        return;
      case FrameType.Data:
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
        if (stream) this.destroy(stream, false);
        return;
      case FrameType.Window:
        if (!stream || frame.payload.length < 4) return;
        stream.sendWindow += frame.payload.readUInt32BE(0);
        if (stream.paused && stream.sendWindow > 0) {
          stream.paused = false;
          stream.socket?.resume();
        }
        return;
    }
  }

  /** Drop every stream, for example when the other side of the tunnel disconnects. */
  resetAll(): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.open) {
        clearTimeout(stream.open.timer);
        stream.open.reject(new Error("The desktop connection closed"));
        stream.open = undefined;
      }
      this.destroy(stream, false);
    }
  }

  private createStream(id: number): Stream {
    const stream: Stream = {
      id,
      socket: null,
      pending: [],
      sendWindow: INITIAL_WINDOW,
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
    let target: { host: string; port: number };
    try {
      target = JSON.parse(payload.toString("utf8")) as { host: string; port: number };
    } catch {
      this.options.send(encodeFrame(FrameType.OpenFail, id, "Malformed open request"));
      return;
    }
    const stream = this.createStream(id);
    try {
      const socket = await this.options.connect(target.host, target.port);
      if (stream.closed) {
        socket.destroy();
        return;
      }
      this.options.send(encodeFrame(FrameType.OpenOk, id));
      this.attach(id, socket);
    } catch (error) {
      this.streams.delete(id);
      stream.closed = true;
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
    }
    if (stream.sendWindow <= 0 && !stream.paused) {
      stream.paused = true;
      stream.socket?.pause();
    }
  }

  private writeLocal(stream: Stream, chunk: Buffer): void {
    const socket = stream.socket;
    if (!socket || socket.destroyed) return;
    const length = chunk.length;
    socket.write(chunk, () => {
      if (!stream.closed) this.options.send(encodeWindow(stream.id, length));
    });
  }

  private maybeFinish(stream: Stream): void {
    if (stream.localEnded && stream.remoteEnded) {
      stream.closed = true;
      this.streams.delete(stream.id);
    }
  }

  private destroy(stream: Stream, notifyRemote: boolean): void {
    if (stream.closed && !this.streams.has(stream.id)) return;
    stream.closed = true;
    this.streams.delete(stream.id);
    if (notifyRemote) this.options.send(encodeFrame(FrameType.Reset, stream.id));
    stream.socket?.destroy();
  }
}
