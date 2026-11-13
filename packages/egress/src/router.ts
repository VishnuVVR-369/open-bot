import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { parseControlMessage, type ControlMessage } from "./frames";
import { Mux, OpenError } from "./mux";
import { connectDirect, createSocksServer, socksReply, SocksReply } from "./socks";
import { egressModeSchema, type EgressMode } from "@open-bot/domain";
import type { WebSocket } from "ws";

/** Chromium gives up on a SOCKS connection 30 s after connecting; answer before that. */
export const CONNECTION_DEADLINE_MS = 28_000;
/** A hold ends early enough to leave this long for opening the connection itself. */
export const OPEN_RESERVE_MS = 8_000;
/** Connections held at once while waiting for a device; more go on without waiting. */
export const MAX_HELD = 256;
/** How long a screen starting or being taken counts as demand, until its lease takes over. */
export const DEMAND_MS = 2 * 60_000;
const DEMAND_RESEND_MS = 30_000;
const REFUSED_WINDOW_MS = 60_000;

interface Config {
  mode: EgressMode;
  agentOnline: boolean;
  /** A phone could be woken, so a connection a screen needs waits for one. */
  wakeable: boolean;
  /** The worker is waking a phone: hold every connection until then (epoch ms). */
  holdUntil: number;
}

export interface EgressRouterOptions {
  log: (message: string) => void;
  onChange: () => void;
  /** Keeps the last mode across restarts, for connections before the worker says. */
  stateFile: string;
  /** Screens leased to a run or to you right now. */
  leasedScreens: () => string[];
  /** Overridable for tests. */
  limits?: Partial<EgressLimits>;
}

export interface EgressLimits {
  deadlineMs: number;
  openReserveMs: number;
  maxHeld: number;
}

/**
 * The computer side of browser egress. Chromium talks SOCKS5 to this router, which sends each
 * connection through one of your devices (by way of the worker's relay) or straight out.
 *
 * Every connection has one deadline, a little under Chromium's own. Within it, the router may
 * wait for a device: while the worker is waking a phone, or while a phone could be woken and a
 * screen is in use (local demand, known at once, before the worker hears of it). A connection a
 * departing device can't finish (`AGENT_GONE`) is routed again while time remains.
 */
export class EgressRouter {
  private tunnel: WebSocket | null = null;
  private mux: Mux | null = null;
  /** Null until the worker's first `config` since botd started. */
  private config: Config | null = null;
  private lastMode: EgressMode | null;
  private readonly demand = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private held = 0;
  private refusals: number[] = [];
  private readonly limits: EgressLimits;

  constructor(private readonly options: EgressRouterOptions) {
    this.lastMode = readLastMode(options.stateFile);
    this.limits = {
      deadlineMs: CONNECTION_DEADLINE_MS,
      openReserveMs: OPEN_RESERVE_MS,
      maxHeld: MAX_HELD,
      ...options.limits,
    };
  }

  get state() {
    const cutoff = Date.now() - REFUSED_WINDOW_MS;
    this.refusals = this.refusals.filter((at) => at > cutoff);
    return {
      mode: this.config?.mode ?? this.lastMode ?? "require",
      agentOnline: this.config?.agentOnline ?? false,
      tunnelConnected: this.tunnel !== null,
      configured: this.config !== null,
      held: this.held,
      refusedRecently: this.refusals.length,
    };
  }

  listen(port: number, host = "127.0.0.1"): Server {
    const server = createSocksServer(
      (host, targetPort, client, acceptedAt) => this.route(host, targetPort, client, acceptedAt),
      (error) =>
        this.options.log(`[egress] ${error instanceof Error ? error.message : String(error)}`),
    );
    server.listen(port, host);
    return server;
  }

  /**
   * A screen is starting or being taken for a run or for you, so browsing is near. Call it before
   * the screen starts: its first connections may then wait for a phone.
   */
  noteDemand(screenId: string): void {
    const now = Date.now();
    const previous = this.demand.get(screenId);
    this.demand.set(screenId, now + DEMAND_MS);
    // Every computer action notes demand; the worker only needs to hear it now and then.
    if (previous === undefined || previous - DEMAND_MS < now - DEMAND_RESEND_MS)
      this.sendText({ type: "demand", screenId });
    this.wake();
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
      transportBuffered: () => socket.bufferedAmount,
    });
    this.mux = mux;
    socket.on("message", (data, isBinary) => {
      if (this.tunnel !== socket) return;
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (!isBinary) {
        const message = parseControlMessage(buffer.toString("utf8"));
        if (message?.type === "config") this.applyConfig(message);
        return;
      }
      try {
        mux.handleFrame(buffer);
      } catch (error) {
        this.options.log(`[egress] dropped a malformed frame: ${String(error)}`);
      }
    });
    socket.on("close", () => {
      if (this.tunnel === socket) this.detachTunnel();
    });
    // The worker may have restarted: tell it again which screens want browsing.
    for (const screenId of this.demandScreens()) this.sendText({ type: "demand", screenId });
    this.options.onChange();
  }

  private applyConfig(message: Extract<ControlMessage, { type: "config" }>): void {
    const previous = this.config;
    // The relay is authoritative about streams: it fails the ones it lost after this message,
    // so nothing is reset here.
    this.config = {
      mode: message.mode,
      agentOnline: message.agentOnline,
      wakeable: message.wakeable ?? false,
      holdUntil: message.holdMs ? Date.now() + message.holdMs : 0,
    };
    if (message.mode !== this.lastMode) {
      this.lastMode = message.mode;
      void writeFile(this.options.stateFile, JSON.stringify({ mode: message.mode })).catch(
        (error: unknown) => this.options.log(`[egress] could not save the mode: ${String(error)}`),
      );
    }
    this.wake();
    if (previous?.mode !== message.mode || previous?.agentOnline !== message.agentOnline)
      this.options.onChange();
  }

  private detachTunnel(): void {
    // Opens still pending fail as `agentGone` and are routed again, without a device now.
    this.mux?.resetAll();
    this.mux = null;
    this.tunnel = null;
    if (this.config) this.config = { ...this.config, agentOnline: false, holdUntil: 0 };
    this.wake();
    this.options.onChange();
  }

  private async route(
    host: string,
    port: number,
    client: Socket,
    acceptedAt: number,
  ): Promise<void> {
    const deadline = acceptedAt + this.limits.deadlineMs;
    const holdLimit = deadline - this.limits.openReserveMs;
    let holding = false;
    try {
      for (;;) {
        if (client.destroyed) return;
        const now = Date.now();
        const config = this.config;

        if (!config) {
          // The worker hasn't said yet (botd just started): wait for it, then go by the last mode.
          if (now < holdLimit && (holding || this.startHold())) {
            holding = true;
            await this.waitForChange(holdLimit, client);
            continue;
          }
          if (this.lastMode === "off" || this.lastMode === "prefer")
            return await connectDirect(host, port, client, { deadline });
          return this.refuse(client);
        }

        if (config.mode === "off") return await connectDirect(host, port, client, { deadline });

        const mux = this.mux;
        if (config.agentOnline && mux) {
          try {
            const streamId = await mux.open(host, port, { deadline });
            if (client.destroyed) {
              mux.reset(streamId);
              return;
            }
            client.write(socksReply(SocksReply.succeeded));
            mux.attach(streamId, client);
            return;
          } catch (error) {
            // The device carrying it went away: route it again, by what's connected now.
            if (error instanceof OpenError && error.agentGone && Date.now() < deadline) continue;
            this.options.log(`[egress] ${host}:${port} via a device failed: ${String(error)}`);
            if (!client.destroyed) client.end(socksReply(SocksReply.hostUnreachable));
            return;
          }
        }

        // No device right now. Wait for one if the worker is waking a phone, or if one could be
        // woken and a screen is in use.
        const waitUntil =
          config.wakeable && this.hasDemand() ? holdLimit : Math.min(holdLimit, config.holdUntil);
        if (now < waitUntil && (holding || this.startHold())) {
          holding = true;
          await this.waitForChange(waitUntil, client);
          continue;
        }
        if (config.mode === "require") return this.refuse(client);
        return await connectDirect(host, port, client, { deadline });
      }
    } finally {
      if (holding) this.held -= 1;
    }
  }

  private startHold(): boolean {
    if (this.held >= this.limits.maxHeld) return false;
    this.held += 1;
    return true;
  }

  /** Wait until something changes (a config, the tunnel, demand), `until`, or the client leaves. */
  private waitForChange(until: number, client: Socket): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        client.off("close", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, until - Date.now()));
      this.waiters.add(done);
      client.once("close", done);
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private refuse(client: Socket): void {
    this.refusals.push(Date.now());
    if (!client.destroyed) client.end(socksReply(SocksReply.notAllowed));
  }

  private hasDemand(): boolean {
    return this.demandScreens().length > 0;
  }

  /** Screens starting or taken in the last few minutes, and screens leased now. */
  private demandScreens(): string[] {
    const now = Date.now();
    for (const [screenId, until] of this.demand) if (until <= now) this.demand.delete(screenId);
    return [...new Set([...this.demand.keys(), ...this.options.leasedScreens()])];
  }

  private sendText(message: ControlMessage): void {
    const socket = this.tunnel;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}

function readLastMode(path: string): EgressMode | null {
  try {
    const { mode } = JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown };
    return egressModeSchema.safeParse(mode).data ?? null;
  } catch {
    return null;
  }
}
