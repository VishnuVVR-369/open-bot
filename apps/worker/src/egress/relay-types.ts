// The relay's options and hooks, and the agents and streams it and the tunnel share.
import type { EgressStatusView } from "@open-bot/api";
import type { AgentRole } from "@open-bot/egress";
import type { EgressMode, PhoneMode, UnavailableReason } from "@open-bot/domain";
import type { EgressAgentClaim } from "@open-bot/domain/server";
import type WebSocket from "ws";

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

/** Close codes agents act on. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4000;

export type Stats = NonNullable<EgressStatusView["stats"]>;

export interface Agent {
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
export interface Route {
  computerId: number;
  agent: Agent;
  agentId: number;
  opening: boolean;
  computerEnded: boolean;
  agentEnded: boolean;
}
