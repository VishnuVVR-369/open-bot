import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ComputerLifecycleStatus, ComputerPhase } from "@open-bot/domain";
import { errorMessage } from "./logger";

export interface LifecycleHooks {
  /** Only retryable lifecycle calls belong here. Never retry user actions. */
  wake(owner: string, signal: AbortSignal): Promise<boolean>;
  restore(signal: AbortSignal): Promise<void>;
  /** False when the computer stays awake because work is still running on it. */
  quiesce(owner: string): Promise<boolean>;
  pause(): void;
  renew(owner: string, demand: number): Promise<void>;
  busy(): boolean;
  changed(status: ComputerLifecycleStatus): void;
  /** A lifecycle step failed in a way the user needn't see. */
  warn(message: string, error: unknown): void;
}

/** One owner, shared wake, and admission serialized against shutdown. No idle computer polling. */
export class ComputerLifecycle {
  private readonly owner = randomUUID();
  private readonly scope = new AsyncLocalStorage<{ active: boolean; signal?: AbortSignal }>();
  private readonly demands = new Map<symbol, string>();
  private transition: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private renewal: NodeJS.Timeout | null = null;
  private renewing = false;
  private stopped = false;
  private compatible = true;
  private state: ComputerLifecycleStatus;

  constructor(
    readonly enabled: boolean,
    private readonly hooks: LifecycleHooks,
    private readonly idleMs = 5 * 60_000,
    private readonly wakeMs = 120_000,
  ) {
    this.state = {
      enabled,
      phase: enabled ? "idle" : "awake",
      error: null,
      demand: [],
      changedAt: new Date().toISOString(),
    };
  }

  get status(): ComputerLifecycleStatus {
    return { ...this.state, demand: [...this.demands.values()] };
  }
  get resting(): boolean {
    return this.enabled && (this.state.phase === "idle" || this.state.phase === "quiescing");
  }
  get inScope(): boolean {
    return this.scope.getStore()?.active === true;
  }

  get signal(): AbortSignal | undefined {
    return this.inScope ? this.scope.getStore()?.signal : undefined;
  }

  private update(phase: ComputerPhase, error: string | null = null) {
    this.state = { ...this.state, phase, error, changedAt: new Date().toISOString() };
    this.hooks.changed(this.status);
  }

  async run<T>(reason: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.enabled || this.inScope) return work();
    const release = await this.hold(reason, signal);
    const scope = { active: true, signal };
    try {
      return await this.scope.run(scope, work);
    } finally {
      scope.active = false;
      release();
    }
  }

  async hold(reason: string, signal?: AbortSignal): Promise<() => void> {
    if (!this.enabled) return () => {};
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Computer lifecycle is stopping");
    const token = Symbol(reason);
    this.demands.set(token, reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.demands.delete(token);
      if (!this.demands.size) this.grace();
    };
    try {
      await abortable(this.admit(), signal);
      signal?.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async admit(): Promise<void> {
    while (this.transition) await this.transition;
    if (this.state.phase === "awake" || this.state.phase === "grace") {
      this.update("awake");
      return;
    }
    const waking = this.wake();
    this.transition = waking;
    try {
      await waking;
    } finally {
      if (this.transition === waking) this.transition = null;
      if (!this.demands.size) this.grace();
    }
  }

  private async wake(): Promise<void> {
    this.update("waking");
    const signal = AbortSignal.timeout(this.wakeMs);
    const scope = { active: true };
    try {
      await abortable(
        this.scope.run(scope, async () => {
          this.compatible = await this.hooks.wake(this.owner, signal);
          if (this.stopped) throw new Error("Computer lifecycle is stopping");
          await this.hooks.restore(signal);
        }),
        signal,
      );
      if (this.stopped) throw new Error("Computer lifecycle is stopping");
      this.update("awake");
      if (this.compatible && !this.renewal) {
        this.renewal = setInterval(() => void this.renew(), 15_000);
        this.renewal.unref();
      }
    } catch (error) {
      this.hooks.pause();
      this.update(
        "idle",
        "The computer didn't wake up. Your next task or Wake screen will try again.",
      );
      throw new Error(`Computer wake failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      scope.active = false;
    }
  }

  private async renew() {
    if (this.renewing || this.resting || this.stopped) return;
    this.renewing = true;
    try {
      await this.hooks.renew(this.owner, this.demands.size);
    } catch (error) {
      // The computer stays usable. Keeping the lease is retried with the next renewal.
      this.hooks.warn("computer lease renewal failed", error);
    } finally {
      this.renewing = false;
    }
  }

  private grace() {
    if (this.stopped || this.transition || this.state.phase === "idle" || !this.compatible) return;
    this.update("grace", this.state.error);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.idle();
    }, this.idleMs);
    this.timer.unref();
  }

  /** Used by the idle timer, and by integration tests. No automatic retry of user work. */
  async idle(): Promise<void> {
    if (this.transition || this.demands.size || this.stopped || !this.compatible) return;
    if (this.hooks.busy()) {
      this.grace();
      return;
    }
    this.update("quiescing");
    const stopping = (async () => {
      try {
        // Admission is now closed. New callers wait for the acknowledgement then wake again.
        if (!(await this.hooks.quiesce(this.owner))) {
          // Work is still running there, which is normal. Try again after another grace period.
          this.update("awake");
          return;
        }
        this.hooks.pause();
        if (this.renewal) clearInterval(this.renewal);
        this.renewal = null;
        this.update("idle");
      } catch (error) {
        this.hooks.warn("computer did not go idle", error);
        this.update("awake");
      }
    })();
    this.transition = stopping;
    try {
      await stopping;
    } finally {
      if (this.transition === stopping) this.transition = null;
      if (!this.demands.size && this.state.phase !== "idle") this.grace();
    }
  }

  /** A running botd/Codex disappeared. Fail current work normally; re-ensure on next demand. */
  connectionLost(): void {
    if (
      !this.enabled ||
      this.stopped ||
      this.state.phase === "idle" ||
      this.state.phase === "quiescing" ||
      this.state.phase === "waking"
    )
      return;
    if (this.timer) clearTimeout(this.timer);
    if (this.renewal) clearInterval(this.renewal);
    this.timer = null;
    this.renewal = null;
    this.update(
      "idle",
      "The connection to the computer dropped. Your next task or Wake screen will reconnect.",
    );
    this.hooks.pause();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.renewal) clearInterval(this.renewal);
    this.hooks.pause();
  }
}

export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
