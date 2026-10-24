import type { Socket } from "node:net";
import {
  connectDirect,
  createSocksServer,
  Mux,
  parseControlMessage,
  socksReply,
  SocksReply,
  type EgressMode,
} from "@open-bot/egress";
import type { WebSocket } from "ws";

/**
 * The computer side of browser egress. Chromium talks SOCKS5 to this router,
 * which sends each connection through your desktop or straight out, depending on the mode.
 */
export class EgressRouter {
  private tunnel: WebSocket | null = null;
  private mux: Mux | null = null;
  private mode: EgressMode = "prefer";
  private agentOnline = false;

  constructor(
    private readonly log: (message: string) => void,
    private readonly onChange: () => void,
  ) {}

  get state() {
    return {
      mode: this.mode,
      agentOnline: this.agentOnline,
      tunnelConnected: this.tunnel !== null,
    };
  }

  listen(port: number): void {
    const server = createSocksServer(
      (host, targetPort, client) => this.route(host, targetPort, client),
      (error) => this.log(`[egress] ${error instanceof Error ? error.message : String(error)}`),
    );
    server.listen(port, "127.0.0.1");
  }

  /** The worker's relay connected. Only one tunnel is active; a new one replaces the old one. */
  attachTunnel(socket: WebSocket): void {
    this.detachTunnel();
    this.tunnel = socket;
    const mux = new Mux({
      role: "computer",
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      },
    });
    this.mux = mux;
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        const message = parseControlMessage(data.toString());
        if (message?.type === "config") {
          this.mode = message.mode;
          if (this.agentOnline && !message.agentOnline) mux.resetAll();
          this.agentOnline = message.agentOnline;
          this.onChange();
        }
        return;
      }
      try {
        mux.handleFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      } catch (error) {
        this.log(`[egress] dropped a malformed frame: ${String(error)}`);
      }
    });
    socket.on("close", () => {
      if (this.tunnel === socket) this.detachTunnel();
    });
    this.onChange();
  }

  private detachTunnel() {
    this.mux?.resetAll();
    this.mux = null;
    this.tunnel = null;
    this.agentOnline = false;
    this.onChange();
  }

  private async route(host: string, port: number, client: Socket): Promise<void> {
    const viaDesktop = this.mode !== "off" && this.agentOnline && this.mux !== null;
    if (!viaDesktop) {
      if (this.mode === "require") {
        client.end(socksReply(SocksReply.notAllowed));
        return;
      }
      await connectDirect(host, port, client);
      return;
    }
    const mux = this.mux!;
    try {
      const streamId = await mux.open(host, port);
      if (client.destroyed) return;
      client.write(socksReply(SocksReply.succeeded));
      mux.attach(streamId, client);
    } catch (error) {
      this.log(`[egress] ${host}:${port} via desktop failed: ${String(error)}`);
      if (!client.destroyed) client.end(socksReply(SocksReply.hostUnreachable));
    }
  }
}
