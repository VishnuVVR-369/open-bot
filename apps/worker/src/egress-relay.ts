import { computers } from "@open-bot/db";
import { parseControlMessage, type ControlMessage, type EgressMode } from "@open-bot/egress";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { publishApp, type Context } from "./context";

export interface EgressStatus {
  mode: EgressMode;
  agentOnline: boolean;
  computerConnected: boolean;
  stats: { openStreams: number; bytesIn: number; bytesOut: number } | null;
  agentSince: string | null;
}

/**
 * Relays the egress tunnel between botd (the computer side) and the Electron agent on your Mac.
 * Frames pass through untouched; the relay only tells each side when the other comes and goes.
 */
export class EgressRelay {
  private computerSocket: WebSocket | null = null;
  private agentSocket: WebSocket | null = null;
  private mode: EgressMode = "prefer";
  private stats: EgressStatus["stats"] = null;
  private agentSince: string | null = null;
  private stopped = false;

  constructor(private readonly ctx: Context) {}

  get status(): EgressStatus {
    return {
      mode: this.mode,
      agentOnline: this.agentSocket?.readyState === WebSocket.OPEN,
      computerConnected: this.computerSocket?.readyState === WebSocket.OPEN,
      stats: this.stats,
      agentSince: this.agentSince,
    };
  }

  async start(): Promise<void> {
    const [row] = await this.ctx.db.select().from(computers).where(eq(computers.id, "default"));
    this.mode = row?.egressMode ?? "prefer";
    this.connectComputer();
  }

  stop(): void {
    this.stopped = true;
    this.computerSocket?.close();
    this.agentSocket?.close();
  }

  async setMode(mode: EgressMode): Promise<void> {
    this.mode = mode;
    await this.ctx.db
      .insert(computers)
      .values({ id: "default", egressMode: mode })
      .onConflictDoUpdate({ target: computers.id, set: { egressMode: mode } });
    this.sendConfig();
    await publishApp(this.ctx, { type: "computer" });
  }

  private sendConfig() {
    const message: ControlMessage = {
      type: "config",
      mode: this.mode,
      agentOnline: this.agentSocket?.readyState === WebSocket.OPEN,
    };
    if (this.computerSocket?.readyState === WebSocket.OPEN)
      this.computerSocket.send(JSON.stringify(message));
  }

  private connectComputer() {
    if (this.stopped) return;
    const socket = new WebSocket(this.ctx.computer.wsUrl("/egress"), { perMessageDeflate: false });
    socket.on("open", () => {
      this.computerSocket = socket;
      this.sendConfig();
      this.sendToAgent({ type: "peer-up" });
      void publishApp(this.ctx, { type: "computer" });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary && this.agentSocket?.readyState === WebSocket.OPEN)
        this.agentSocket.send(data, { binary: true });
    });
    socket.on("close", () => {
      if (this.computerSocket === socket) {
        this.computerSocket = null;
        this.sendToAgent({ type: "peer-down" });
        void publishApp(this.ctx, { type: "computer" });
      }
      setTimeout(() => this.connectComputer(), 3_000);
    });
    socket.on("error", () => {});
  }

  private sendToAgent(message: ControlMessage) {
    if (this.agentSocket?.readyState === WebSocket.OPEN)
      this.agentSocket.send(JSON.stringify(message));
  }

  /** The Electron agent connected. A newer agent replaces an older one. */
  attachAgent(socket: WebSocket): void {
    const previous = this.agentSocket;
    this.agentSocket = socket;
    this.agentSince = new Date().toISOString();
    if (previous && previous !== socket)
      previous.close(4000, "Replaced by a newer desktop connection");
    // Streams of the old agent are gone, so the computer side must drop them too.
    if (previous) this.sendConfigOffline();
    this.sendConfig();
    if (this.computerSocket?.readyState !== WebSocket.OPEN) this.sendToAgent({ type: "peer-down" });
    this.ctx.log.info("desktop egress agent connected");
    void publishApp(this.ctx, { type: "computer" });

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        const message = parseControlMessage(data.toString());
        if (message?.type === "stats") {
          this.stats = {
            openStreams: message.openStreams,
            bytesIn: message.bytesIn,
            bytesOut: message.bytesOut,
          };
        }
        return;
      }
      if (this.computerSocket?.readyState === WebSocket.OPEN)
        this.computerSocket.send(data, { binary: true });
    });
    socket.on("close", () => {
      if (this.agentSocket !== socket) return;
      this.agentSocket = null;
      this.stats = null;
      this.agentSince = null;
      this.sendConfig();
      this.ctx.log.info("desktop egress agent disconnected");
      void publishApp(this.ctx, { type: "computer" });
    });
    socket.on("error", () => {});
  }

  private sendConfigOffline() {
    if (this.computerSocket?.readyState === WebSocket.OPEN) {
      this.computerSocket.send(
        JSON.stringify({
          type: "config",
          mode: this.mode,
          agentOnline: false,
        } satisfies ControlMessage),
      );
    }
  }
}
