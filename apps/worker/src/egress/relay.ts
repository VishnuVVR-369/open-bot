import type { EgressStatusView } from "@open-bot/api";
import { AGENT_GONE, encodeFrame, FrameType, type AgentRole } from "@open-bot/egress";
import type { EgressMode, PhoneMode } from "@open-bot/domain";
import type { EgressAgentClaim } from "@open-bot/domain/server";
import WebSocket from "ws";
import { errorMessage } from "../logger";
import {
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  type Agent,
  type PairedPhone,
  type RelayHooks,
  type RelayOptions,
  type RelayTimings,
  type Route,
} from "./relay-types";
import {
  abandon,
  connectComputer,
  dropComputerStreams,
  fromAgent,
  heartbeat,
  phoneControl,
  sendComputer,
  sendConfig,
  sendText,
} from "./tunnel";

// What other modules import from the relay, wherever it is declared.
export {
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  type PairedPhone,
  type RelayHooks,
  type RelayOptions,
  type RelayStore,
  type RelayTimings,
} from "./relay-types";
export { MAX_AGENT_BUFFER } from "./tunnel";

const DEFAULT_TIMINGS: RelayTimings = {
  heartbeatMs: 15_000,
  drainMs: 2 * 60_000,
  reconcileMs: 30_000,
  computerRetryMs: 3_000,
};

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
 *
 * The frames and the computer's socket are in `tunnel.ts`, which works on the members that aren't
 * `private` here (`TunnelRelay`). Code outside the egress folder uses only the methods and getters.
 */
export class EgressRelay {
  readonly timings: RelayTimings;
  computer: WebSocket | null = null;
  computerPaused = false;
  computerGeneration = 0;
  openingComputer: WebSocket | null = null;
  computerMissedPongs = 0;
  computerTimer: NodeJS.Timeout | null = null;
  readonly routes = new Map<number, Route>();
  readonly agents = new Map<string, Agent>();
  active: Agent | null = null;
  mode: EgressMode = "prefer";
  private phoneMode: PhoneMode = "fallback";
  private phones: PairedPhone[] = [];
  private phonesRequested = 0;
  private phonesApplied = 0;
  /** Per phone: attach and revoke run one at a time, in order. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly intervals: NodeJS.Timeout[] = [];
  hooks: RelayHooks = {};
  private changeQueued = false;
  stopped = false;

  constructor(readonly options: RelayOptions) {
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
    if (!this.computerPaused) connectComputer(this);
    this.intervals.push(
      setInterval(() => heartbeat(this), this.timings.heartbeatMs),
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
    dropComputerStreams(this);
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
    if (!this.computer && !this.openingComputer) connectComputer(this);
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
      if (agent.claim.kind === "phone") sendText(this, agent, { type: "policy", phoneMode: mode });
    this.refresh(true);
  }

  /** Send the computer a fresh `config`, for example when the wake controller's state changes. */
  configChanged(): void {
    sendConfig(this);
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
        for (const [data, isBinary] of early) if (!isBinary) phoneControl(this, claim.id, data);
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
    socket.on("message", (data, isBinary) => fromAgent(this, agent, data, isBinary));
    socket.on("pong", () => {
      agent.missedPongs = 0;
    });
    socket.on("close", () => this.detach(agent));
    socket.on("error", () => {});
    if (previous) {
      previous.socket.close(CLOSE_REPLACED, "Replaced by a newer connection");
      this.detach(previous);
    }
    if (!this.computerConnected) sendText(this, agent, { type: "peer-down" });
    if (claim.kind === "phone")
      sendText(this, agent, { type: "policy", phoneMode: this.phoneMode });
    this.options.log.info("egress agent connected", { kind: claim.kind, name: claim.name });
    this.refresh(false);
    this.changed();
    for (const [data, isBinary] of early) fromAgent(this, agent, data, isBinary);
  }

  /** The agent is gone: re-pick the active agent, tell the computer, then fail its streams. */
  detach(agent: Agent): void {
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
      sendComputer(
        this,
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
      sendConfig(this);
      this.changed();
    }
  }

  /** A standby agent's grace is over: reset what it still carries, and let a phone go. */
  private drainOver(agent: Agent): void {
    agent.drainTimer = null;
    if (this.computerPaused || agent.detached || agent === this.active) return;
    if (agent.claim.kind === "phone") this.release(agent);
    else for (const route of [...agent.streams.values()]) abandon(this, route);
  }

  /**
   * A standby phone with nothing left to carry is let go at once, except while it stands by for
   * your Mac in `fallback`: then it waits out the grace in case the Mac drops again.
   */
  releaseIfDrained(agent: Agent): void {
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
    for (const route of [...agent.streams.values()]) abandon(this, route);
    this.changed();
  }

  private setRole(agent: Agent, role: AgentRole): void {
    if (agent.role === role) return;
    agent.role = role;
    sendText(this, agent, { type: "role", role });
  }

  /* ---------------------------------------------------------------- upkeep */

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

  changed(): void {
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
