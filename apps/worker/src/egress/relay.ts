import type { EgressStatusView } from "@open-bot/api";
import {
  AGENT_GONE,
  encodeFrame,
  FrameType,
  parseControlMessage,
  type AgentRole,
  type ControlMessage,
} from "@open-bot/egress";
import type { EgressMode, PhoneMode, UnavailableReason } from "@open-bot/domain";
import type { EgressAgentClaim } from "@open-bot/domain/server";
import WebSocket from "ws";
import { errorMessage } from "../logger";

/** What the relay needs from the database. */
export interface RelayStore {
  loadModes(): Promise<{ mode: EgressMode; phoneMode: PhoneMode }>;
  saveMode(mode: EgressMode): Promise<void>;
  savePhoneMode(mode: PhoneMode): Promise<void>;
  /** Phones that are paired and not revoked. */
  pairedPhones(): Promise<PairedPhone[]>;
}

export interface PairedPhone {
  id: string;
  name: string;
  generation: number;
  pushToken: string | null;
  lastUsedAt: string | null;
}

/** What the wake controller adds to the relay; the relay works without one. */
export interface RelayHooks {
  /** Extra `config` fields: whether a phone could be woken, and how long to hold for one. */
  configExtras?(): { wakeable?: boolean; holdMs?: number };
  /** The phone-specific parts of the status: being woken, unavailable, unanswered. */
  phoneStatus?(
    id: string,
  ): Pick<EgressStatusView["phones"][number], "waking" | "unavailable" | "unanswered">;
  /** Whether a phone is being woken right now, so the path is "waiting". */
  waiting?(): boolean;
  onDemand?(screenId: string): void;
  onUnavailable?(phoneId: string, reason: UnavailableReason, seq?: number): void;
  /** A phone connected and carries traffic again: its reports up to `seq` are over. */
  onAvailable?(phoneId: string, seq: number): void;
  /** Agents, roles, modes or paired phones changed. */
  onChange?(): void;
}

export interface RelayOptions {
  store: RelayStore;
  /** The computer's egress endpoint (botd). */
  computerUrl: () => string;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** Tell the web app the status changed. */
  publish: () => void;
  timings?: Partial<RelayTimings>;
}

export interface RelayTimings {
  /** How often every socket is pinged; two unanswered pings end it. */
  heartbeatMs: number;
  /** How long an agent that stopped being active keeps carrying its streams. */
  drainMs: number;
  /** How often attached phones are checked against the database. */
  reconcileMs: number;
  /** Delay before reconnecting to the computer. */
  computerRetryMs: number;
}

const DEFAULT_TIMINGS: RelayTimings = {
  heartbeatMs: 15_000,
  drainMs: 2 * 60_000,
  reconcileMs: 30_000,
  computerRetryMs: 3_000,
};

/** An agent whose socket holds more than this is too slow or stuck, and is dropped. */
export const MAX_AGENT_BUFFER = 32 * 1024 * 1024;
/** Close codes agents act on. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4000;
const HEADER_BYTES = 5;
const MAX_STREAM_ID = 0xffff_ffff;

type Stats = NonNullable<EgressStatusView["stats"]>;

interface Agent {
  key: string;
  claim: EgressAgentClaim;
  socket: WebSocket;
  connectedAt: number;
  since: string;
  stats: Stats | null;
  /** The last role sent to it. */
  role: AgentRole | null;
  detached: boolean;
  /** Its stream ids, which count up for the life of the connection and are never reused. */
  streams: Map<number, Route>;
  nextId: number;
  missedPongs: number;
  /** Runs while it isn't the active agent: when it ends, its remaining streams are reset. */
  drainTimer: NodeJS.Timeout | null;
}

/** One stream, known by the computer's id and by the id its agent knows it by. */
interface Route {
  computerId: number;
  agent: Agent;
  agentId: number;
  opening: boolean;
  computerEnded: boolean;
  agentEnded: boolean;
}

/**
 * Relays the egress tunnel between botd (the computer side) and the devices that carry its
 * traffic: the desktop app on your Mac and your paired phones.
 *
 * The relay picks one active agent for new connections, by the phone mode. Every stream is
 * translated between the computer's id and an id private to the agent connection carrying it,
 * so an agent can only ever touch its own streams, and nothing from an earlier connection on
 * either side can reach a new stream. An agent that stops being active keeps its streams until
 * they end, for `drainMs`.
 *
 * Ordering: whenever availability changes, the computer gets the new `config` first, then the
 * terminal frames for the streams that were lost, so it re-routes them knowing what's left.
 */
export class EgressRelay {
  private readonly timings: RelayTimings;
  private computer: WebSocket | null = null;
  private computerPaused = false;
  private computerGeneration = 0;
  private openingComputer: WebSocket | null = null;
  private computerMissedPongs = 0;
  private computerTimer: NodeJS.Timeout | null = null;
  private readonly routes = new Map<number, Route>();
  private readonly agents = new Map<string, Agent>();
  private active: Agent | null = null;
  private mode: EgressMode = "prefer";
  private phoneMode: PhoneMode = "fallback";
  private phones: PairedPhone[] = [];
  private phonesRequested = 0;
  private phonesApplied = 0;
  /** Per phone: attach and revoke run one at a time, in order. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly intervals: NodeJS.Timeout[] = [];
  private hooks: RelayHooks = {};
  private changeQueued = false;
  private stopped = false;

  constructor(private readonly options: RelayOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  setHooks(hooks: RelayHooks): void {
    this.hooks = hooks;
  }

  async start(): Promise<void> {
    const modes = await this.options.store.loadModes();
    this.mode = modes.mode;
    this.phoneMode = modes.phoneMode;
    await this.loadPhones();
    if (!this.computerPaused) this.connectComputer();
    this.intervals.push(
      setInterval(() => this.heartbeat(), this.timings.heartbeatMs),
      setInterval(() => void this.reconcile(), this.timings.reconcileMs),
    );
    for (const interval of this.intervals) interval.unref();
  }

  /** Pause only the computer tunnel. Desktop/phone sockets and heartbeats stay attached. */
  pauseComputer(): void {
    this.computerPaused = true;
    this.computerGeneration++;
    if (this.computerTimer) clearTimeout(this.computerTimer);
    this.computerTimer = null;
    const computer = this.computer;
    this.computer = null;
    this.openingComputer?.terminate();
    this.openingComputer = null;
    computer?.terminate();
    this.dropComputerStreams();
    this.changed();
  }

  async resumeComputer(): Promise<void> {
    const generation = this.computerGeneration;
    // Reconcile durable policy before any browser is admitted, even if an edit's notification
    // was missed while sleeping. A revoked phone must never carry the first post-wake request.
    const modes = await this.options.store.loadModes();
    await this.loadPhones();
    if (generation !== this.computerGeneration || this.stopped)
      throw new Error("Stale egress resume discarded");
    this.mode = modes.mode;
    this.phoneMode = modes.phoneMode;
    for (const agent of [...this.agents.values()]) {
      if (agent.claim.kind !== "phone") continue;
      const phone = this.phones.find((phone) => phone.id === agent.claim.id);
      if (!phone || phone.generation !== agent.claim.generation) {
        agent.socket.close(CLOSE_REVOKED, "revoked");
        this.detach(agent);
      }
    }
    this.computerPaused = false;
    this.refresh(true);
    if (!this.computer && !this.openingComputer) this.connectComputer();
  }

  stop(): void {
    this.stopped = true;
    this.pauseComputer();
    for (const interval of this.intervals) clearInterval(interval);
    if (this.computerTimer) clearTimeout(this.computerTimer);
    this.computer?.close();
    for (const agent of this.agents.values()) {
      if (agent.drainTimer) clearTimeout(agent.drainTimer);
      agent.socket.close(1001, "Worker stopping");
    }
  }

  get currentMode(): EgressMode {
    return this.mode;
  }

  get currentPhoneMode(): PhoneMode {
    return this.phoneMode;
  }

  get pairedPhones(): readonly PairedPhone[] {
    return this.phones;
  }

  /** Which kind of agent carries new connections, if any. */
  get activeKind(): EgressAgentClaim["kind"] | null {
    return this.active?.claim.kind ?? null;
  }

  /** The phone carrying new connections, and since when it's connected (epoch ms). */
  get activePhone(): { id: string; since: number } | null {
    const active = this.active;
    return active?.claim.kind === "phone"
      ? { id: active.claim.id, since: active.connectedAt }
      : null;
  }

  /** Ids of the phones connected right now. */
  get connectedPhones(): string[] {
    return [...this.agents.values()]
      .filter((agent) => agent.claim.kind === "phone" && agent.role !== "release")
      .map((agent) => agent.claim.id);
  }

  /** When the phone's current connection began (epoch ms), or null if it isn't connected. */
  phoneConnectedAt(id: string): number | null {
    let latest: number | null = null;
    for (const agent of this.agents.values()) {
      if (agent.claim.kind !== "phone" || agent.claim.id !== id || agent.role === "release")
        continue;
      latest = Math.max(latest ?? 0, agent.connectedAt);
    }
    return latest;
  }

  get computerConnected(): boolean {
    return this.computer?.readyState === WebSocket.OPEN;
  }

  get status(): EgressStatusView {
    const active = this.active;
    const agents = [...this.agents.values()].filter((agent) => agent.role !== "release");
    const online = new Set(
      agents.filter((agent) => agent.claim.kind === "phone").map((agent) => agent.claim.id),
    );
    const path: EgressStatusView["path"] = active
      ? active.claim.kind
      : this.mode === "off"
        ? "direct"
        : this.hooks.waiting?.()
          ? "waiting"
          : this.mode === "require"
            ? "blocked"
            : "direct";
    return {
      mode: this.mode,
      agentOnline: active !== null,
      computerConnected: this.computerConnected,
      stats: active?.stats ?? null,
      agentSince: active?.since ?? null,
      phoneMode: this.phoneMode,
      path,
      agents: agents.map((agent) => ({
        kind: agent.claim.kind,
        id: agent.claim.id,
        name: agent.claim.name,
        role: agent === active ? ("active" as const) : ("standby" as const),
        since: agent.since,
        stats: agent.stats,
      })),
      phones: this.phones.map((phone) => ({
        id: phone.id,
        name: phone.name,
        online: online.has(phone.id),
        waking: null,
        unavailable: null,
        unanswered: null,
        ...this.hooks.phoneStatus?.(phone.id),
        lastUsedAt: phone.lastUsedAt,
      })),
    };
  }

  async setMode(mode: EgressMode): Promise<void> {
    await this.options.store.saveMode(mode);
    this.mode = mode;
    this.refresh(true);
  }

  async setPhoneMode(mode: PhoneMode): Promise<void> {
    await this.options.store.savePhoneMode(mode);
    this.phoneMode = mode;
    for (const agent of this.agents.values())
      if (agent.claim.kind === "phone") this.sendText(agent, { type: "policy", phoneMode: mode });
    this.refresh(true);
  }

  /** Send the computer a fresh `config`, for example when the wake controller's state changes. */
  configChanged(): void {
    this.sendConfig();
    this.options.publish();
  }

  /**
   * A device connected with a verified token. A phone is attached only if its pairing in the
   * database is current, checked in order with revocations, so a revoke can't be overtaken.
   */
  async attachAgent(socket: WebSocket, claim: EgressAgentClaim): Promise<void> {
    if (claim.kind !== "phone") {
      this.adopt(socket, claim);
      return;
    }
    // What the phone sends while its pairing is checked is kept, and handled once it's attached.
    const early: [WebSocket.RawData, boolean][] = [];
    const keep = (data: WebSocket.RawData, isBinary: boolean) => early.push([data, isBinary]);
    socket.on("message", keep);
    socket.on("error", () => {});
    await this.serial(claim.id, async () => {
      try {
        await this.loadPhones();
      } catch (error) {
        this.options.log.warn("could not check a phone's pairing", { error: errorMessage(error) });
        socket.close(1011, "Try again");
        return;
      }
      const phone = this.phones.find((row) => row.id === claim.id);
      if (!phone || phone.generation !== claim.generation) {
        socket.close(CLOSE_REVOKED, "revoked");
        return;
      }
      socket.off("message", keep);
      if (socket.readyState !== WebSocket.OPEN) {
        // It left already; why it left still counts.
        for (const [data, isBinary] of early) if (!isBinary) this.phoneControl(claim.id, data);
        return;
      }
      this.adopt(socket, { ...claim, name: phone.name }, early);
    });
  }

  /**
   * A phone's pairing was revoked or replaced: disconnect it if it is on that generation or an
   * older one. A newer pairing is never touched.
   */
  async revoke(phoneId: string, generation: number): Promise<void> {
    await this.serial(phoneId, async () => {
      for (const agent of [...this.agents.values()]) {
        if (agent.claim.kind !== "phone" || agent.claim.id !== phoneId) continue;
        if ((agent.claim.generation ?? 0) > generation) continue;
        agent.socket.close(CLOSE_REVOKED, "revoked");
        this.detach(agent);
      }
    });
    await this.reloadPhones();
  }

  /** Paired phones changed (paired, renamed, a new push token). */
  async reloadPhones(): Promise<void> {
    try {
      await this.loadPhones();
    } catch (error) {
      this.options.log.warn("could not load paired phones", { error: errorMessage(error) });
    }
  }

  /** Tell a phone to disconnect and stop; what it still carries is reset. */
  releasePhone(phoneId: string): void {
    for (const agent of [...this.agents.values()])
      if (agent.claim.kind === "phone" && agent.claim.id === phoneId) this.release(agent);
  }

  /* ---------------------------------------------------------------- agents */

  private adopt(
    socket: WebSocket,
    claim: EgressAgentClaim,
    early: [WebSocket.RawData, boolean][] = [],
  ): void {
    const key = `${claim.kind}:${claim.id}`;
    const now = Date.now();
    const agent: Agent = {
      key,
      claim,
      socket,
      connectedAt: now,
      since: new Date(now).toISOString(),
      stats: null,
      role: null,
      detached: false,
      streams: new Map(),
      nextId: 1,
      missedPongs: 0,
      drainTimer: null,
    };
    const previous = this.agents.get(key);
    this.agents.set(key, agent);
    socket.on("message", (data, isBinary) => this.fromAgent(agent, data, isBinary));
    socket.on("pong", () => {
      agent.missedPongs = 0;
    });
    socket.on("close", () => this.detach(agent));
    socket.on("error", () => {});
    if (previous) {
      previous.socket.close(CLOSE_REPLACED, "Replaced by a newer connection");
      this.detach(previous);
    }
    if (!this.computerConnected) this.sendText(agent, { type: "peer-down" });
    if (claim.kind === "phone") this.sendText(agent, { type: "policy", phoneMode: this.phoneMode });
    this.options.log.info("egress agent connected", { kind: claim.kind, name: claim.name });
    this.refresh(false);
    this.changed();
    for (const [data, isBinary] of early) this.fromAgent(agent, data, isBinary);
  }

  /** The agent is gone: re-pick the active agent, tell the computer, then fail its streams. */
  private detach(agent: Agent): void {
    if (agent.detached) return;
    agent.detached = true;
    if (this.agents.get(agent.key) === agent) this.agents.delete(agent.key);
    if (agent.drainTimer) clearTimeout(agent.drainTimer);
    agent.drainTimer = null;
    const lost = [...agent.streams.values()];
    agent.streams.clear();
    for (const route of lost) this.routes.delete(route.computerId);
    this.refresh(false);
    for (const route of lost)
      this.sendComputer(
        route.opening
          ? encodeFrame(FrameType.OpenFail, route.computerId, AGENT_GONE)
          : encodeFrame(FrameType.Reset, route.computerId),
      );
    this.options.log.info("egress agent disconnected", {
      kind: agent.claim.kind,
      name: agent.claim.name,
      streams: lost.length,
    });
    this.changed();
  }

  /** Who carries new connections: by the phone mode, then the most recently connected. */
  private pickActive(): Agent | null {
    if (this.mode === "off") return null;
    const newest = (kind: EgressAgentClaim["kind"]) => {
      let best: Agent | null = null;
      for (const agent of this.agents.values())
        if (
          agent.claim.kind === kind &&
          agent.role !== "release" &&
          (!best || agent.connectedAt >= best.connectedAt)
        )
          best = agent;
      return best;
    };
    const desktop = newest("desktop");
    const phone = this.phoneMode === "off" ? null : newest("phone");
    return this.phoneMode === "always" ? (phone ?? desktop) : (desktop ?? phone);
  }

  /** Re-pick the active agent, give every agent its role, and tell the computer if that changed. */
  private refresh(forceConfig: boolean): void {
    const previous = this.active;
    const next = this.pickActive();
    this.active = next;
    for (const agent of this.agents.values()) {
      if (agent === next) {
        if (agent.drainTimer) clearTimeout(agent.drainTimer);
        agent.drainTimer = null;
        this.setRole(agent, "active");
        continue;
      }
      if (agent.role === "release") continue;
      this.setRole(agent, "standby");
      agent.drainTimer ??= setTimeout(() => this.drainOver(agent), this.timings.drainMs);
      this.releaseIfDrained(agent);
    }
    if (forceConfig || previous !== next) {
      this.sendConfig();
      this.changed();
    }
  }

  /** A standby agent's grace is over: reset what it still carries, and let a phone go. */
  private drainOver(agent: Agent): void {
    agent.drainTimer = null;
    if (this.computerPaused || agent.detached || agent === this.active) return;
    if (agent.claim.kind === "phone") this.release(agent);
    else for (const route of [...agent.streams.values()]) this.abandon(route);
  }

  /**
   * A standby phone with nothing left to carry is let go at once, except while it stands by for
   * your Mac in `fallback`: then it waits out the grace in case the Mac drops again.
   */
  private releaseIfDrained(agent: Agent): void {
    if (
      this.computerPaused ||
      agent.claim.kind !== "phone" ||
      agent === this.active ||
      agent.role === "release"
    )
      return;
    if (agent.streams.size > 0) return;
    const waitingForMac =
      this.mode !== "off" && this.phoneMode === "fallback" && this.active?.claim.kind === "desktop";
    if (!waitingForMac) this.release(agent);
  }

  private release(agent: Agent): void {
    if (agent.claim.kind !== "phone" || agent.role === "release") return;
    if (agent.drainTimer) clearTimeout(agent.drainTimer);
    agent.drainTimer = null;
    this.setRole(agent, "release");
    this.options.log.info("egress phone released", { name: agent.claim.name });
    // The new `config` first, then the streams it can no longer carry.
    if (this.active === agent) this.refresh(false);
    for (const route of [...agent.streams.values()]) this.abandon(route);
    this.changed();
  }

  /** End a stream its agent won't carry: one still opening may be routed again. */
  private abandon(route: Route): void {
    this.sendAgent(route.agent, encodeFrame(FrameType.Reset, route.agentId));
    this.sendComputer(
      route.opening
        ? encodeFrame(FrameType.OpenFail, route.computerId, AGENT_GONE)
        : encodeFrame(FrameType.Reset, route.computerId),
    );
    this.forget(route);
  }

  private setRole(agent: Agent, role: AgentRole): void {
    if (agent.role === role) return;
    agent.role = role;
    this.sendText(agent, { type: "role", role });
  }

  private fromAgent(agent: Agent, data: WebSocket.RawData, isBinary: boolean): void {
    if (agent.detached) return;
    if (!isBinary) {
      const message = parseControlMessage(rawToBuffer(data).toString("utf8"));
      if (message?.type === "stats") {
        agent.stats = {
          openStreams: message.openStreams,
          bytesIn: message.bytesIn,
          bytesOut: message.bytesOut,
        };
      } else if (agent.claim.kind === "phone") {
        this.phoneControl(agent.claim.id, data);
      }
      return;
    }
    const frame = rawToBuffer(data);
    if (frame.length < HEADER_BYTES) return;
    const type = frame[0];
    const agentId = frame.readUInt32BE(1);
    const route = agent.streams.get(agentId);
    if (!route) {
      // Like TCP, data for a stream that's gone is refused, so the sender stops waiting.
      if (type === FrameType.Data) this.sendAgent(agent, encodeFrame(FrameType.Reset, agentId));
      return;
    }
    switch (type) {
      case FrameType.OpenOk:
        if (!route.opening) return;
        route.opening = false;
        this.toComputer(route, frame);
        return;
      case FrameType.OpenFail:
        if (!route.opening) return;
        this.toComputer(route, frame);
        this.forget(route);
        return;
      case FrameType.Data:
      case FrameType.Window:
        if (route.opening) return;
        this.toComputer(route, frame);
        return;
      case FrameType.End:
        if (route.opening || route.agentEnded) return;
        route.agentEnded = true;
        this.toComputer(route, frame);
        if (route.computerEnded) this.forget(route);
        return;
      case FrameType.Reset:
        this.toComputer(route, frame);
        this.forget(route);
        return;
      default:
        // Agents never open streams.
        return;
    }
  }

  /** A phone's own control messages: that it is back, or why it's about to leave. */
  private phoneControl(phoneId: string, data: WebSocket.RawData): void {
    const message = parseControlMessage(rawToBuffer(data).toString("utf8"));
    if (message?.type === "unavailable")
      this.hooks.onUnavailable?.(phoneId, message.reason, message.seq);
    else if (message?.type === "available") this.hooks.onAvailable?.(phoneId, message.seq);
  }

  private toComputer(route: Route, frame: Buffer): void {
    frame.writeUInt32BE(route.computerId, 1);
    this.sendComputer(frame);
  }

  private toAgent(route: Route, frame: Buffer): void {
    frame.writeUInt32BE(route.agentId, 1);
    this.sendAgent(route.agent, frame);
  }

  /** Stop tracking a finished stream; a standby phone with nothing left may then go. */
  private forget(route: Route): void {
    if (this.routes.get(route.computerId) === route) this.routes.delete(route.computerId);
    route.agent.streams.delete(route.agentId);
    if (route.agent.role === "standby") this.releaseIfDrained(route.agent);
  }

  private sendAgent(agent: Agent, data: Buffer): void {
    const socket = agent.socket;
    if (agent.detached || socket.readyState !== WebSocket.OPEN) return;
    socket.send(data, { binary: true });
    if (socket.bufferedAmount > MAX_AGENT_BUFFER) {
      this.options.log.warn("egress agent too slow, dropping it", { name: agent.claim.name });
      socket.terminate();
      this.detach(agent);
    }
  }

  private sendText(agent: Agent, message: ControlMessage): void {
    if (!agent.detached && agent.socket.readyState === WebSocket.OPEN)
      agent.socket.send(JSON.stringify(message));
  }

  /* -------------------------------------------------------------- computer */

  private connectComputer(): void {
    if (this.stopped || this.computerPaused || this.openingComputer || this.computer) return;
    const generation = this.computerGeneration;
    const socket = new WebSocket(this.options.computerUrl(), {
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    this.openingComputer = socket;
    socket.on("open", () => {
      if (this.stopped || this.computerPaused || generation !== this.computerGeneration) {
        socket.terminate();
        return;
      }
      this.openingComputer = null;
      this.computer = socket;
      this.computerMissedPongs = 0;
      // `config` is always the first message on a tunnel connection.
      this.sendConfig();
      for (const agent of this.agents.values()) this.sendText(agent, { type: "peer-up" });
      this.changed();
    });
    socket.on("message", (data, isBinary) => {
      if (this.computer !== socket) return;
      if (isBinary) {
        this.fromComputer(rawToBuffer(data));
        return;
      }
      const message = parseControlMessage(rawToBuffer(data).toString("utf8"));
      if (message?.type === "demand") this.hooks.onDemand?.(message.screenId);
    });
    socket.on("pong", () => {
      if (this.computer === socket) this.computerMissedPongs = 0;
    });
    socket.on("close", () => {
      if (this.openingComputer === socket) this.openingComputer = null;
      if (generation !== this.computerGeneration) return;
      if (this.computer === socket) {
        this.computer = null;
        this.dropComputerStreams();
        this.changed();
      }
      if (!this.stopped && !this.computerPaused)
        this.computerTimer = setTimeout(() => {
          this.computerTimer = null;
          if (generation === this.computerGeneration) this.connectComputer();
        }, this.timings.computerRetryMs);
    });
    socket.on("error", () => {});
  }

  /** The computer side went away: every stream is gone, and agents drop theirs. */
  private dropComputerStreams(): void {
    for (const route of this.routes.values()) route.agent.streams.delete(route.agentId);
    this.routes.clear();
    for (const agent of [...this.agents.values()]) {
      this.sendText(agent, { type: "peer-down" });
      if (agent.role === "standby") this.releaseIfDrained(agent);
    }
  }

  private fromComputer(frame: Buffer): void {
    if (frame.length < HEADER_BYTES) return;
    const type = frame[0];
    const computerId = frame.readUInt32BE(1);
    if (type === FrameType.Open) {
      this.open(computerId, frame);
      return;
    }
    const route = this.routes.get(computerId);
    if (!route) {
      if (type === FrameType.Data) this.sendComputer(encodeFrame(FrameType.Reset, computerId));
      return;
    }
    switch (type) {
      case FrameType.Data:
      case FrameType.Window:
        this.toAgent(route, frame);
        return;
      case FrameType.End:
        if (route.computerEnded) return;
        route.computerEnded = true;
        this.toAgent(route, frame);
        if (route.agentEnded) this.forget(route);
        return;
      case FrameType.Reset:
        this.toAgent(route, frame);
        this.forget(route);
        return;
      default:
        return;
    }
  }

  private open(computerId: number, frame: Buffer): void {
    if (this.routes.has(computerId)) {
      this.sendComputer(encodeFrame(FrameType.OpenFail, computerId, "Stream id already in use"));
      return;
    }
    let agent = this.active;
    if (agent && agent.nextId > MAX_STREAM_ID) {
      // Billions of streams on one connection: start the agent over rather than reuse an id.
      agent.socket.close(CLOSE_REPLACED, "Out of stream ids");
      this.detach(agent);
      agent = this.active;
    }
    if (!agent) {
      this.sendComputer(encodeFrame(FrameType.OpenFail, computerId, AGENT_GONE));
      return;
    }
    const route: Route = {
      computerId,
      agent,
      agentId: agent.nextId,
      opening: true,
      computerEnded: false,
      agentEnded: false,
    };
    agent.nextId += 2;
    this.routes.set(computerId, route);
    agent.streams.set(route.agentId, route);
    this.toAgent(route, frame);
  }

  private sendComputer(data: Buffer | string): void {
    const socket = this.computer;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(data, { binary: typeof data !== "string" });
  }

  private sendConfig(): void {
    const message: ControlMessage = {
      type: "config",
      mode: this.mode,
      agentOnline: this.active !== null,
      ...this.hooks.configExtras?.(),
    };
    this.sendComputer(JSON.stringify(message));
  }

  /* ----------------------------------------------------------- upkeep */

  private heartbeat(): void {
    for (const agent of [...this.agents.values()]) {
      if (agent.missedPongs >= 2) {
        this.options.log.warn("egress agent stopped answering", { name: agent.claim.name });
        agent.socket.terminate();
        this.detach(agent);
        continue;
      }
      agent.missedPongs += 1;
      if (agent.socket.readyState === WebSocket.OPEN) agent.socket.ping();
    }
    const computer = this.computer;
    if (computer?.readyState === WebSocket.OPEN) {
      if (this.computerMissedPongs >= 2) {
        this.options.log.warn("the computer's egress tunnel stopped answering");
        computer.terminate();
        return;
      }
      this.computerMissedPongs += 1;
      computer.ping();
    }
  }

  /** Disconnect phones whose pairing was revoked or replaced, in case a notice was lost. */
  private async reconcile(): Promise<void> {
    try {
      await this.loadPhones();
    } catch (error) {
      this.options.log.warn("could not reconcile paired phones", { error: errorMessage(error) });
      return;
    }
    for (const agent of [...this.agents.values()]) {
      if (agent.claim.kind !== "phone") continue;
      await this.serial(agent.claim.id, async () => {
        // Checked again in the queue: an attach or revoke may have run in between.
        const current = this.phones.find((phone) => phone.id === agent.claim.id);
        if (agent.detached || current?.generation === agent.claim.generation) return;
        agent.socket.close(CLOSE_REVOKED, "revoked");
        this.detach(agent);
      });
    }
  }

  /**
   * Read the paired phones. Reads overlap (attaches, the reconciler), so a read only counts if no
   * read that started after it has finished: an older snapshot never replaces a newer one.
   */
  private async loadPhones(): Promise<void> {
    const sequence = ++this.phonesRequested;
    const phones = await this.options.store.pairedPhones();
    if (sequence < this.phonesApplied) return;
    this.phonesApplied = sequence;
    const before = JSON.stringify(this.phones);
    this.phones = phones;
    if (JSON.stringify(phones) !== before) this.changed();
  }

  private serial(phoneId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(phoneId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // The caller gets `next` and its error; `settled` only keeps this phone's queue moving.
    const settled = next.catch(() => {});
    this.queues.set(phoneId, settled);
    void settled.then(() => {
      if (this.queues.get(phoneId) === settled) this.queues.delete(phoneId);
    });
    return next;
  }

  private changed(): void {
    // The hook runs once the relay's own update is complete, never in the middle of one.
    if (!this.changeQueued) {
      this.changeQueued = true;
      queueMicrotask(() => {
        this.changeQueued = false;
        this.hooks.onChange?.();
      });
    }
    this.options.publish();
  }
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
