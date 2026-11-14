import { EventEmitter } from "node:events";
import type { ScreenStatus } from "@open-bot/domain";
import type { LeaseChange } from "./lease";
import { MAX_SLOTS, Screen, type ScreenDeps } from "./screens";

export interface ScreenManagerOptions {
  /** Screens running at once. Starting another stops the one unused the longest. */
  maxRunning?: number;
  admissionMs?: number;
  /** A screen nobody has used or watched for this long stops. */
  idleMs?: number;
  now?: () => number;
}

/**
 * The teammates' screens on the shared computer, keyed by teammate id. A screen starts the first
 * time its teammate or you use it, and stops after a while unused; its browser profile stays on disk.
 */
export class ScreenManager extends EventEmitter<{
  lease: [string, LeaseChange];
  changed: [];
}> {
  private readonly screens = new Map<string, Screen>();
  private readonly starting = new Map<string, Promise<Screen>>();
  private readonly startingWaiters = new Map<string, { count: number; abort: AbortController }>();
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly admissionMs: number;
  private readonly waiters = new Set<() => void>();
  private readonly stopping = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: ScreenDeps,
    options: ScreenManagerOptions = {},
  ) {
    super();
    this.maxRunning = options.maxRunning ?? 4;
    if (!Number.isInteger(this.maxRunning) || this.maxRunning < 1 || this.maxRunning > MAX_SLOTS)
      throw new Error("Invalid MAX_SCREENS");
    this.admissionMs = options.admissionMs ?? 120_000;
    this.idleMs = options.idleMs ?? 20 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get(id: string): Screen | undefined {
    const screen = this.screens.get(id);
    return screen?.state === "running" ? screen : undefined;
  }

  list(): ScreenStatus[] {
    const active = [...this.screens.values()].map((screen) => screen.status());
    for (const id of this.deps.codeScreens?.ids ?? []) {
      if (!active.some((screen) => screen.id === id))
        active.push({
          id,
          state: "paused",
          browser: "stopped",
          lease: {
            kind: "user-code",
            since: new Date(this.now()).toISOString(),
            lastInputAt: new Date(this.now()).toISOString(),
            pausedForSafety: true,
          },
        });
    }
    return active;
  }

  codeAvailable(id: string): boolean {
    return this.deps.codeScreens?.available(id) ?? true;
  }

  async typeCode(
    id: string,
    input: { operationId: string; expectedSite: string; text: string; pressEnter: boolean },
  ) {
    const screen = this.get(id);
    if (!screen || !this.deps.codeScreens)
      return { status: "failed" as const, reason: "The screen is offline." };
    return this.deps.codeScreens.type(screen, input);
  }

  touch(screen: Screen): void {
    screen.lastUsedAt = this.now();
  }

  /** Whether any screen is starting, stopping, held or downloading. */
  get busy(): boolean {
    return (
      this.starting.size > 0 ||
      this.stopping.size > 0 ||
      [...this.screens.values()].some((s) => s.busy || s.lease.holder !== null)
    );
  }

  /** The teammate's screen, started if it isn't running. */
  ensure(id: string, signal?: AbortSignal): Promise<Screen> {
    signal?.throwIfAborted();
    const running = this.get(id);
    if (running) {
      this.touch(running);
      return Promise.resolve(running);
    }
    let pending = this.starting.get(id);
    if (!pending) {
      const abort = new AbortController();
      this.startingWaiters.set(id, { count: 0, abort });
      pending = this.startScreen(id, abort.signal).finally(() => {
        this.starting.delete(id);
        this.startingWaiters.delete(id);
      });
      this.starting.set(id, pending);
    }
    const waiters = this.startingWaiters.get(id)!;
    waiters.count++;
    return new Promise<Screen>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    }).finally(() => {
      waiters.count--;
      if (!waiters.count && this.starting.get(id) === pending)
        waiters.abort.abort(new Error("Screen request cancelled"));
    });
  }

  private freeSlot(): number {
    const used = new Set([...this.screens.values()].map((screen) => screen.slot));
    for (let slot = 0; slot < MAX_SLOTS; slot += 1) if (!used.has(slot)) return slot;
    throw new Error("Too many screens are running");
  }

  private async startScreen(id: string, signal?: AbortSignal): Promise<Screen> {
    const previous = this.screens.get(id);
    if (previous) await this.stopScreen(previous);
    // Waiters recheck after each wake; admission and the map reservation have no await between them.
    const deadline = Date.now() + this.admissionMs;
    while (this.screens.size >= this.maxRunning) {
      signal?.throwIfAborted();
      const idle = this.screenToStop();
      if (idle) {
        // stopScreen() records it as stopping at once, so a start running alongside picks another.
        this.deps.log(`[screens] stopping ${idle.id} to make room`);
        await this.stopScreen(idle).catch((error: unknown) =>
          this.deps.log(`[screens] could not stop ${idle.id} to make room: ${String(error)}`),
        );
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("All screen slots are busy. Try again when a screen is free.");
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          done();
          reject(signal!.reason);
        };
        const timer = setTimeout(done, remaining);
        this.waiters.add(done);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    signal?.throwIfAborted();

    const screen = new Screen(id, this.freeSlot(), this.deps, this.now());
    this.screens.set(id, screen);
    this.deps.codeScreens?.attach(screen);
    screen.lease.on("change", (change) => {
      this.touch(screen);
      this.emit("lease", id, change);
    });
    // Taking over stops whatever the teammate was doing on this screen right away.
    screen.lease.on("preempted", () => screen.desktop.abortAll());
    this.emit("changed");
    this.deps.log(`[screens] starting ${id} on ${screen.display}`);
    try {
      await screen.start();
      signal?.throwIfAborted();
    } catch (error) {
      this.deps.log(`[screens] ${id} failed to start: ${String(error)}`);
      await this.stopScreen(screen);
      throw error;
    }
    this.touch(screen);
    this.emit("changed");
    return screen;
  }

  /**
   * The screen to stop when all slots are taken: a running one nobody holds and with no download,
   * preferring one nobody watches, then the one used least recently. Its profile stays on disk.
   */
  private screenToStop(): Screen | undefined {
    return [...this.screens.values()]
      .filter(
        (screen) =>
          screen.state === "running" &&
          screen.lease.holder === null &&
          !screen.busy &&
          !this.stopping.has(screen.id),
      )
      .sort(
        (a, b) => Number(a.viewers > 0) - Number(b.viewers > 0) || a.lastUsedAt - b.lastUsedAt,
      )[0];
  }

  private stopScreen(screen: Screen): Promise<void> {
    let pending = this.stopping.get(screen.id);
    if (pending) return pending;
    if (this.screens.get(screen.id) !== screen) return Promise.resolve();
    pending = screen
      .stop()
      .then(() => {
        this.screens.delete(screen.id);
        this.emit("changed");
        for (const waiter of this.waiters) waiter();
      })
      .finally(() => this.stopping.delete(screen.id));
    this.stopping.set(screen.id, pending);
    return pending;
  }

  /** The teammate is gone: stop its screen and delete its browser profile. */
  async forget(id: string): Promise<void> {
    await this.starting.get(id)?.catch(() => {});
    const screen = this.screens.get(id) ?? new Screen(id, -1, this.deps, this.now());
    if (this.screens.get(id) === screen) await this.stopScreen(screen);
    await screen.forget();
  }

  releaseRun(runId: string): boolean {
    let released = false;
    for (const screen of this.screens.values())
      released = screen.lease.releaseRun(runId) || released;
    return released;
  }

  /** Time out leases, and stop screens nobody has used for a while. Watching alone doesn't count as use. */
  sweep(): void {
    const now = this.now();
    for (const screen of [...this.screens.values()]) {
      screen.lease.sweep();
      if (
        screen.state === "running" &&
        screen.lease.holder === null &&
        !screen.busy &&
        !this.deps.workActive?.() &&
        now - screen.lastUsedAt >= this.idleMs
      ) {
        this.deps.log(
          `[screens] stopping ${screen.id} after ${Math.round(this.idleMs / 60_000)} idle minutes`,
        );
        void this.stopScreen(screen).catch((error: unknown) =>
          this.deps.log(`[screens] shutdown failed: ${String(error)}`),
        );
      }
    }
  }

  async stopAll(): Promise<void> {
    if (this.starting.size) throw new Error("Screens are still starting");
    for (const screen of this.screens.values()) await this.stopScreen(screen);
  }
}
