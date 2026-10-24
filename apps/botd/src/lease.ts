import { EventEmitter } from "node:events";
import type { LeaseHolder, RunIdentity } from "@open-bot/shared";

export type LeaseReleaseReason =
  "handed_back" | "user_idle" | "user_disconnected" | "run_finished" | "run_idle" | "preempted";

export interface LeaseChange {
  holder: LeaseHolder;
  previous: LeaseHolder;
  reason: LeaseReleaseReason | "acquired";
}

export interface LeaseOptions {
  now?: () => number;
  /** A run that hasn't acted for this long loses the lease. */
  runIdleMs?: number;
  /** How long a run waits for another run to release the lease. */
  waitMs?: number;
  /** You lose control after this long without input. */
  userIdleMs?: number;
  /** You lose control after your control connection has been gone this long. */
  userDisconnectMs?: number;
}

export type AcquireResult = "ok" | "user_has_control" | "desktop_busy";

/**
 * The single desktop lease. At any moment it is free, held by one bot run, or held by you.
 * You always win: taking over preempts any run immediately.
 */
export class DesktopLease extends EventEmitter<{
  change: [LeaseChange];
  preempted: [RunIdentity];
}> {
  private current: LeaseHolder = null;
  private readonly now: () => number;
  private readonly runIdleMs: number;
  private readonly waitMs: number;
  private readonly userIdleMs: number;
  private readonly userDisconnectMs: number;
  private readonly userConnections = new Set<string>();
  private userDisconnectedAt: number | null = null;

  constructor(options: LeaseOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.runIdleMs = options.runIdleMs ?? 2 * 60_000;
    this.waitMs = options.waitMs ?? 30_000;
    this.userIdleMs = options.userIdleMs ?? 10 * 60_000;
    this.userDisconnectMs = options.userDisconnectMs ?? 90_000;
  }

  get holder(): LeaseHolder {
    return this.current;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private set(holder: LeaseHolder, reason: LeaseChange["reason"]) {
    const previous = this.current;
    // Control connections belong to one takeover, so they don't carry over to the next one.
    if (previous?.kind === "user" && holder?.kind !== "user") this.userConnections.clear();
    this.current = holder;
    this.emit("change", { holder, previous, reason });
  }

  /** Try to take the lease right now, without waiting. */
  private tryAcquire(run: RunIdentity): AcquireResult {
    const holder = this.current;
    if (holder?.kind === "user") return "user_has_control";
    if (holder?.kind === "run" && holder.runId === run.runId) {
      this.current = { ...holder, lastActionAt: this.iso() };
      return "ok";
    }
    if (holder?.kind === "run" && this.now() - Date.parse(holder.lastActionAt) < this.runIdleMs) {
      return "desktop_busy";
    }
    if (holder?.kind === "run") this.set(null, "run_idle");
    const since = this.iso();
    this.set({ kind: "run", ...run, since, lastActionAt: since }, "acquired");
    return "ok";
  }

  /** Take the lease for a run, waiting up to `waitMs` while another run holds it. */
  async acquireForRun(run: RunIdentity): Promise<AcquireResult> {
    const deadline = this.now() + this.waitMs;
    for (;;) {
      const result = this.tryAcquire(run);
      if (result !== "desktop_busy" || this.now() >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  releaseRun(runId: string, reason: LeaseReleaseReason = "run_finished"): boolean {
    if (this.current?.kind === "run" && this.current.runId === runId) {
      this.set(null, reason);
      return true;
    }
    return false;
  }

  /** You take control. Any run that held the lease is preempted. */
  takeByUser(): LeaseHolder {
    const previous = this.current;
    if (previous?.kind === "user") return previous;
    if (previous?.kind === "run") {
      this.emit("preempted", {
        runId: previous.runId,
        botId: previous.botId,
        botName: previous.botName,
      });
    }
    const since = this.iso();
    this.userDisconnectedAt = this.userConnections.size === 0 ? this.now() : null;
    this.set({ kind: "user", since, lastInputAt: since }, previous ? "preempted" : "acquired");
    return previous;
  }

  releaseByUser(
    reason: "handed_back" | "user_idle" | "user_disconnected" = "handed_back",
  ): boolean {
    if (this.current?.kind !== "user") return false;
    this.set(null, reason);
    return true;
  }

  /** Record input from your control connection. */
  touchUser(): void {
    if (this.current?.kind === "user") {
      this.current = { ...this.current, lastInputAt: this.iso() };
    }
  }

  userConnected(connectionId: string): void {
    this.userConnections.add(connectionId);
    this.userDisconnectedAt = null;
  }

  userDisconnected(connectionId: string): void {
    if (!this.userConnections.delete(connectionId)) return;
    if (this.userConnections.size === 0) this.userDisconnectedAt = this.now();
  }

  /** Release leases that timed out. Call this periodically. */
  sweep(): void {
    const holder = this.current;
    const now = this.now();
    if (holder?.kind === "run" && now - Date.parse(holder.lastActionAt) >= this.runIdleMs) {
      this.set(null, "run_idle");
    } else if (holder?.kind === "user") {
      if (
        this.userDisconnectedAt !== null &&
        now - this.userDisconnectedAt >= this.userDisconnectMs
      ) {
        this.set(null, "user_disconnected");
      } else if (now - Date.parse(holder.lastInputAt) >= this.userIdleMs) {
        this.set(null, "user_idle");
      }
    }
  }
}
