import net, { type Socket } from "node:net";
import { parseControlMessage, type AgentRole } from "./frames";
import { resolvePublicAddress } from "./ip-policy";
import { Mux, type MuxStats } from "./mux";

export type AgentStatus = "connecting" | "online" | "offline";

export interface EgressAgentOptions {
  /** Returns a websocket URL with a fresh short-lived token. */
  getUrl: () => Promise<string>;
  onStatus?: (status: AgentStatus, detail?: string) => void;
  /** What the relay wants from this agent: carry new connections, or stand by. */
  onRole?: (role: AgentRole) => void;
  log?: (message: string) => void;
  /** Overridable for tests. */
  resolve?: typeof resolvePublicAddress;
}

/** How long making one connection may take, including the name lookup. */
const CONNECT_TIMEOUT_MS = 15_000;
const STATS_INTERVAL_MS = 5_000;

/**
 * Runs on your Mac (inside Electron). Opens the computer's browser connections from your network.
 */
export class EgressAgent {
  private socket: WebSocket | null = null;
  private mux: Mux | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private status: AgentStatus = "offline";

  constructor(private readonly options: EgressAgentOptions) {}

  get currentStatus(): AgentStatus {
    return this.status;
  }

  get stats(): MuxStats {
    return this.mux?.stats ?? { openStreams: 0, bytesIn: 0, bytesOut: 0 };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  /** Try again right away, for example right after you sign in. */
  retryNow(): void {
    if (this.stopped || this.status !== "offline") return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.mux?.resetAll();
    this.socket?.close(1000, "Agent stopped");
    this.socket = null;
    this.setStatus("offline");
  }

  private setStatus(status: AgentStatus, detail?: string) {
    this.status = status;
    this.options.onStatus?.(status, detail);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    let url: string;
    try {
      url = await this.options.getUrl();
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : "Could not get a token");
      return;
    }
    if (this.stopped) return;

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const mux = new Mux({
      role: "agent",
      send: (frame) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array(frame));
      },
      connect: (host, port, signal) => this.openConnection(host, port, signal),
      transportBuffered: () => socket.bufferedAmount,
    });
    this.mux = mux;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.setStatus("online");
      this.statsTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "stats", ...mux.stats }));
        }
      }, STATS_INTERVAL_MS);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = parseControlMessage(event.data);
        if (message?.type === "peer-down") mux.resetAll();
        if (message?.type === "role") this.options.onRole?.(message.role);
        return;
      }
      try {
        mux.handleFrame(Buffer.from(event.data as ArrayBuffer));
      } catch (error) {
        this.options.log?.(`Dropped a malformed frame: ${String(error)}`);
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.statsTimer) clearInterval(this.statsTimer);
      mux.resetAll();
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect(event.reason || `Disconnected (${event.code})`);
    });
    socket.addEventListener("error", () => {
      // The close event follows and schedules the reconnect.
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    this.setStatus("offline", reason);
    const delay = Math.min(30_000, 1_000 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async openConnection(host: string, port: number, signal: AbortSignal): Promise<Socket> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid port");
    // One limit for the lookup and the connection together, and both stop when the stream does.
    const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    const both = AbortSignal.any([signal, timeout]);
    const aborted = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(
          new Error(
            timeout.aborted ? `Timed out connecting to ${host}:${port}` : "Connection cancelled",
          ),
        );
      if (both.aborted) fail();
      else both.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => {});
    const address = await Promise.race([
      (this.options.resolve ?? resolvePublicAddress)(host),
      aborted,
    ]);
    return new Promise<Socket>((resolve, reject) => {
      const socket = net.connect({ host: address, port });
      socket.setNoDelay(true);
      const onAbort = () => {
        socket.destroy();
        reject(
          new Error(
            timeout.aborted ? `Timed out connecting to ${host}:${port}` : "Connection cancelled",
          ),
        );
      };
      if (both.aborted) {
        onAbort();
        return;
      }
      both.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        both.removeEventListener("abort", onAbort);
        // The mux resumes the socket when it attaches it.
        socket.pause();
        resolve(socket);
      });
      socket.once("error", (error) => {
        both.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }
}
