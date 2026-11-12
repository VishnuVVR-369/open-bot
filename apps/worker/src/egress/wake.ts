import { UNAVAILABLE_MESSAGES, type EgressStatusView } from "@open-bot/api";
import type {
  CarryingPhoneMode,
  EgressMode,
  EgressPushStage,
  PhoneMode,
  PhoneWakeStage,
  UnavailableReason,
} from "@open-bot/domain";
import type { PushResult } from "../services/fcm";
import type { PairedPhone } from "./relay";
import { errorMessage } from "../logger";

/** What the wake controller reads from, and asks of, the relay. */
export interface WakeRelay {
  readonly currentMode: EgressMode;
  readonly currentPhoneMode: PhoneMode;
  readonly activeKind: "desktop" | "phone" | null;
  /** The phone carrying new connections, and since when (epoch ms). */
  readonly activePhone: { id: string; since: number } | null;
  readonly connectedPhones: string[];
  /** When the phone's current connection began (epoch ms), or null if it isn't connected. */
  phoneConnectedAt(id: string): number | null;
  readonly pairedPhones: readonly PairedPhone[];
  configChanged(): void;
  releasePhone(id: string): void;
}

export interface WakeDeps {
  now: () => number;
  relay: WakeRelay;
  /** Screens leased to a run or to you right now. */
  leasedScreens: () => string[];
  /** Whether pushes can be sent at all. */
  pushConfigured: () => boolean;
  /** Push to one phone, with the phone mode now. A token that's gone has already been forgotten. */
  push: (
    phone: PairedPhone,
    stage: EgressPushStage,
    phoneMode: CarryingPhoneMode,
  ) => Promise<PushResult>;
  /** Paired phones changed (a token was forgotten). */
  phonesChanged: () => void;
  /** Tell you through your other channels that the phone didn't answer. */
  notifyUnanswered: () => Promise<void>;
  /** The status changed (for the web app). */
  publish: () => void;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
  /** Overridable for tests. */
  timings?: Partial<WakeTimings>;
}

export interface WakeTimings {
  demandMs: number;
  startGraceMs: number;
  retryMs: number;
  askMs: number;
  episodeMs: number;
  alwaysBackoffMs: readonly number[];
  suppressMs: number;
  releaseIdleMs: number;
  noticeMs: number;
}

export const WAKE_TIMINGS: WakeTimings = {
  /** Demand ends this long after the last `demand` message or leased screen. */
  demandMs: 10 * 60_000,
  /** After the worker starts, devices get this long to come back on their own. */
  startGraceMs: 60_000,
  /** `fallback`: wake again at +30 s, ask at +60 s. */
  retryMs: 30_000,
  askMs: 60_000,
  /** `fallback`: a new episode after an unanswered one, if demand is still there. */
  episodeMs: 15 * 60_000,
  /** `always`: waits between wakes, then the last one repeats. */
  alwaysBackoffMs: [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000],
  /** A phone that said it can't help isn't asked again for this long. */
  suppressMs: 15 * 60_000,
  /** `fallback`: a phone carrying traffic with no demand for this long is let go. */
  releaseIdleMs: 10 * 60_000,
  /** The unanswered notice through other channels, at most this often. */
  noticeMs: 60 * 60_000,
};

interface PhoneState {
  suppressedUntil: number;
  reason: UnavailableReason | null;
  /** When it said so: only a connection made after that clears it. */
  reportedAt: number;
  /** The phone said its reports up to this one are over: an older one arriving late is ignored. */
  availableSeq: number;
  /** The current report's number, if it has one: only an `available` covering it clears it. */
  reportSeq: number | null;
  /** When the wakes it didn't answer began, until it connects. */
  unansweredSince: number | null;
}

/** `fallback`: one try at bringing a phone back while the Mac is away and a screen needs it. */
interface Episode {
  startedAt: number;
  stage: PhoneWakeStage | "done";
}

/** `always`: wakes with backoff for as long as no phone is connected. */
interface AlwaysWaking {
  startedAt: number;
  attempts: number;
  nextAt: number;
  askedAt: number | null;
}

/**
 * Decides when to wake paired phones, from demand, the relay's state and each phone's answers.
 * A state machine driven by `evaluate()`, which the worker calls every second and on every
 * change; the clock and the pushes are injected, so tests run it on a fake clock.
 */
export class WakeController {
  private readonly startedAt: number;
  private lastDemandAt = Number.NEGATIVE_INFINITY;
  private readonly phones = new Map<string, PhoneState>();
  private episode: Episode | null = null;
  private always: AlwaysWaking | null = null;
  /** botd holds connections until then, even without demand of its own. */
  private holdUntil = 0;
  private lastNoticeAt = Number.NEGATIVE_INFINITY;
  private lastConfig = "";
  private evaluating = false;

  private readonly timings: WakeTimings;

  constructor(private readonly deps: WakeDeps) {
    this.startedAt = deps.now();
    this.timings = { ...WAKE_TIMINGS, ...deps.timings };
  }

  /** botd says a screen is starting or being taken. */
  demand(): void {
    this.lastDemandAt = this.deps.now();
    this.evaluate();
  }

  /** A phone can't carry traffic right now; don't ask it again for a while. */
  unavailable(phoneId: string, reason: UnavailableReason, seq?: number): void {
    const state = this.phone(phoneId);
    if (seq !== undefined) {
      // Over already, or older than the report that stands (they can arrive out of order).
      if (seq <= state.availableSeq) return;
      if (state.reason !== null && state.reportSeq !== null && seq < state.reportSeq) return;
    }
    state.suppressedUntil = this.deps.now() + this.timings.suppressMs;
    state.reason = reason;
    state.reportedAt = this.deps.now();
    state.reportSeq = seq ?? null;
    this.evaluate();
    this.deps.publish();
  }

  /** A phone connected and carries traffic again, so its reports up to `seq` are over. */
  available(phoneId: string, seq: number): void {
    const state = this.phone(phoneId);
    state.availableSeq = Math.max(state.availableSeq, seq);
    state.unansweredSince = null;
    // A newer report than this one (the tunnel's message can be processed late) still stands.
    if (state.reportSeq === null || state.reportSeq <= seq)
      Object.assign(state, { suppressedUntil: 0, reason: null, reportSeq: null });
    this.evaluate();
    this.deps.publish();
  }

  /** The `config` fields for botd. */
  configExtras(): { wakeable: boolean; holdMs?: number } {
    const remaining = this.holdUntil - this.deps.now();
    return { wakeable: this.wakeable(), ...(remaining > 0 ? { holdMs: remaining } : {}) };
  }

  /** Whether the path is "waiting": a phone is being woken and hasn't answered yet. */
  waiting(): boolean {
    return (
      (this.episode !== null && this.episode.stage !== "done" && this.episode.stage !== "ask") ||
      (this.always !== null && this.eligible().length > 0)
    );
  }

  phoneStatus(
    id: string,
  ): Pick<EgressStatusView["phones"][number], "waking" | "unavailable" | "unanswered"> {
    const now = this.deps.now();
    const state = this.phones.get(id);
    const eligible = this.eligible().some((phone) => phone.id === id);
    const waking =
      eligible && this.episode && this.episode.stage !== "done"
        ? { since: iso(this.episode.startedAt), stage: this.episode.stage }
        : eligible && this.always
          ? {
              since: iso(this.always.startedAt),
              stage: (this.always.askedAt ? "ask" : "wake") as PhoneWakeStage,
            }
          : null;
    return {
      waking,
      unavailable:
        state?.reason && state.suppressedUntil > now
          ? {
              reason: state.reason,
              message: UNAVAILABLE_MESSAGES[state.reason],
              until: iso(state.suppressedUntil),
            }
          : null,
      unanswered: state?.unansweredSince ? iso(state.unansweredSince) : null,
    };
  }

  /** Run the state machine. Safe to call at any time and as often as you like. */
  evaluate(): void {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      this.step();
    } finally {
      this.evaluating = false;
    }
    const config = JSON.stringify({ wakeable: this.wakeable(), holdUntil: this.holdUntil });
    if (config !== this.lastConfig) {
      this.lastConfig = config;
      this.deps.relay.configChanged();
    }
  }

  private step(): void {
    const now = this.deps.now();
    const relay = this.deps.relay;
    if (this.deps.leasedScreens().length > 0) this.lastDemandAt = now;
    const demand = now - this.lastDemandAt < this.timings.demandMs;
    const connected = relay.connectedPhones;
    this.observeConnections();
    const on = relay.currentMode !== "off" && relay.currentPhoneMode !== "off";
    const canPush =
      on && this.deps.pushConfigured() && now - this.startedAt >= this.timings.startGraceMs;
    if (this.holdUntil <= now) this.holdUntil = 0;

    if (relay.currentPhoneMode === "fallback") {
      this.always = null;
      const needed = on && demand && relay.activeKind === null && connected.length === 0;
      if (!needed) this.endEpisode();
      else if (canPush) this.stepEpisode(now);
      // A phone carrying traffic nobody needs any more is let go.
      const active = relay.activeKind === "phone" ? relay.activePhone : null;
      if (active && now - Math.max(this.lastDemandAt, active.since) >= this.timings.releaseIdleMs)
        relay.releasePhone(active.id);
    } else if (relay.currentPhoneMode === "always") {
      this.endEpisode();
      if (!on || connected.length > 0) {
        this.always = null;
        this.holdUntil = 0;
      } else if (canPush) this.stepAlways(now, demand);
    } else {
      this.endEpisode();
      this.always = null;
    }
    // Nothing left to wait for.
    if (this.eligible().length === 0) this.holdUntil = 0;
  }

  private stepEpisode(now: number): void {
    const episode = this.episode;
    if (
      !episode ||
      (episode.stage === "done" && now - episode.startedAt >= this.timings.episodeMs)
    ) {
      if (this.eligible().length === 0) return;
      this.episode = { startedAt: now, stage: "wake" };
      this.holdUntil = now + this.timings.askMs;
      this.pushAll("wake");
      this.deps.publish();
      return;
    }
    if (episode.stage === "wake" && now - episode.startedAt >= this.timings.retryMs) {
      episode.stage = "retry";
      this.pushAll("wake");
      this.deps.publish();
    }
    if (episode.stage === "retry" && now - episode.startedAt >= this.timings.askMs) {
      episode.stage = "ask";
      this.askAll(episode.startedAt);
      episode.stage = "done";
      this.holdUntil = 0;
      this.deps.publish();
    }
  }

  private stepAlways(now: number, demand: boolean): void {
    if (this.eligible().length === 0) return;
    const waking = (this.always ??= { startedAt: now, attempts: 0, nextAt: now, askedAt: null });
    if (now >= waking.nextAt) {
      const backoff = this.timings.alwaysBackoffMs;
      waking.nextAt = now + backoff[Math.min(waking.attempts, backoff.length - 1)]!;
      waking.attempts += 1;
      this.pushAll("wake");
      if (demand) this.holdUntil = now + this.timings.askMs;
      this.deps.publish();
    }
    // With a screen waiting on it, ask you too, once per episode's length.
    const askDue =
      waking.askedAt === null
        ? now - waking.startedAt >= this.timings.askMs
        : now - waking.askedAt >= this.timings.episodeMs;
    if (demand && askDue) {
      waking.askedAt = now;
      this.askAll(waking.startedAt);
      this.deps.publish();
    }
  }

  private endEpisode(): void {
    if (this.episode && this.episode.stage !== "done") this.holdUntil = 0;
    this.episode = null;
  }

  /** Ask every eligible phone to be tapped, mark them unanswered, and tell you elsewhere. */
  private askAll(since: number): void {
    for (const phone of this.eligible()) {
      const state = this.phone(phone.id);
      state.unansweredSince ??= since;
    }
    this.pushAll("ask");
    const now = this.deps.now();
    if (now - this.lastNoticeAt >= this.timings.noticeMs) {
      this.lastNoticeAt = now;
      void this.deps.notifyUnanswered().catch((error: unknown) =>
        this.deps.log.warn("could not send the unanswered phone notice", {
          error: errorMessage(error),
        }),
      );
    }
  }

  private pushAll(stage: EgressPushStage): void {
    const phoneMode = this.deps.relay.currentPhoneMode;
    if (phoneMode === "off") return;
    for (const phone of this.eligible()) {
      void this.deps
        .push(phone, stage, phoneMode)
        .then((result) => {
          if (result === "gone") this.deps.phonesChanged();
        })
        .catch((error: unknown) =>
          this.deps.log.warn("could not wake a phone", { error: errorMessage(error) }),
        );
    }
  }

  /** Phones that may be woken: paired, with a push token, not connected, not suppressed. */
  private eligible(): PairedPhone[] {
    const now = this.deps.now();
    const connected = new Set(this.deps.relay.connectedPhones);
    return this.deps.relay.pairedPhones.filter(
      (phone) =>
        phone.pushToken !== null &&
        !connected.has(phone.id) &&
        (this.phones.get(phone.id)?.suppressedUntil ?? 0) <= now,
    );
  }

  /** Whether botd should hold on local demand: a phone could be woken now, or soon. */
  private wakeable(): boolean {
    const relay = this.deps.relay;
    return (
      relay.currentMode !== "off" &&
      relay.currentPhoneMode !== "off" &&
      this.deps.pushConfigured() &&
      this.eligible().length > 0
    );
  }

  /**
   * A phone that has connected has answered. Numbered reports are cleared by the phone's
   * `available` instead. An unnumbered one (from an older app) is cleared by a connection made
   * after it, even one that replaces a connection that went dead with the network.
   */
  private observeConnections(): void {
    for (const [id, state] of this.phones) {
      const connectedAt = this.deps.relay.phoneConnectedAt(id);
      if (connectedAt === null) continue;
      state.unansweredSince = null;
      // A numbered report is only cleared by an `available` covering it: a connection can be
      // adopted after a newer report arrived, while still covering only older ones.
      if (state.reportSeq === null && connectedAt > state.reportedAt)
        Object.assign(state, { suppressedUntil: 0, reason: null });
    }
  }

  private phone(id: string): PhoneState {
    let state = this.phones.get(id);
    if (!state) {
      state = {
        suppressedUntil: 0,
        reason: null,
        reportedAt: 0,
        availableSeq: -1,
        reportSeq: null,
        unansweredSince: null,
      };
      this.phones.set(id, state);
    }
    return state;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
