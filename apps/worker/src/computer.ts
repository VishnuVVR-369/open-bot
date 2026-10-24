import { EventEmitter } from "node:events";
import type {
  ComputerAction,
  ComputerActionError,
  ComputerActionResult,
  ComputerEvent,
  ComputerFillRequest,
  ComputerFillResult,
  ComputerHealth,
  ComputerReadResult,
  LeaseChangeReason,
  LeaseHolder,
  RunIdentity,
} from "@open-bot/shared";
import WebSocket from "ws";
import type { Logger } from "./logger";

export type LeaseReleaseReason = "handed_back" | "user_idle" | "user_disconnected";

/**
 * Talks to botd inside the computer: desktop actions, each screen's lease, and its event stream.
 * Emits `lease` when a screen's lease changes and `health` when the computer's health changes.
 */
export class ComputerClient extends EventEmitter<{
  lease: [string, LeaseHolder, LeaseHolder, LeaseChangeReason | undefined];
  health: [ComputerHealth | null];
  connected: [];
}> {
  private eventsSocket: WebSocket | null = null;
  private lastHealth: ComputerHealth | null = null;
  /** Who holds each running screen, by screen (bot) id. */
  private readonly leases = new Map<string, LeaseHolder>();
  private stopped = false;
  private reconnectDelay = 1_000;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log: Logger,
  ) {
    super();
  }

  get health(): ComputerHealth | null {
    return this.lastHealth;
  }

  /** Who holds a bot's screen. */
  lease(screenId: string): LeaseHolder {
    return this.leases.get(screenId) ?? null;
  }

  /** Every screen someone holds. */
  heldScreens(): { screenId: string; holder: NonNullable<LeaseHolder> }[] {
    return [...this.leases]
      .filter((entry): entry is [string, NonNullable<LeaseHolder>] => entry[1] !== null)
      .map(([screenId, holder]) => ({ screenId, holder }));
  }

  get online(): boolean {
    return this.eventsSocket?.readyState === WebSocket.OPEN && this.lastHealth !== null;
  }

  wsUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.baseUrl.replace(/^http/, "ws"));
    url.searchParams.set("token", this.token);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  start(): void {
    this.stopped = false;
    this.connectEvents();
  }

  stop(): void {
    this.stopped = true;
    this.eventsSocket?.close();
  }

  private connectEvents() {
    if (this.stopped) return;
    const socket = new WebSocket(this.wsUrl("/events"));
    this.eventsSocket = socket;
    socket.on("open", () => {
      this.reconnectDelay = 1_000;
      this.log.info("connected to the computer");
      this.emit("connected");
    });
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ComputerEvent;
      if (event.type === "lease") {
        this.setLease(event.screenId, event.holder, event.reason ?? "acquired");
      } else if (event.type === "health") {
        // A screen that stopped holds nothing.
        const running = new Set(event.health.screens.map((screen) => screen.id));
        for (const screenId of [...this.leases.keys()])
          if (!running.has(screenId)) this.setLease(screenId, null, "run_idle");
        const changed = JSON.stringify(this.lastHealth) !== JSON.stringify(event.health);
        this.lastHealth = event.health;
        if (changed) this.emit("health", event.health);
      }
    });
    socket.on("close", () => {
      if (this.eventsSocket !== socket) return;
      this.eventsSocket = null;
      if (this.lastHealth !== null) {
        this.lastHealth = null;
        this.emit("health", null);
      }
      if (!this.stopped) {
        setTimeout(() => this.connectEvents(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
      }
    });
    socket.on("error", (error) => {
      if (this.reconnectDelay <= 2_000) this.log.warn(`computer events: ${error.message}`);
    });
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
  ): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`botd ${path} returned ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  action(
    run: RunIdentity,
    action: ComputerAction,
  ): Promise<ComputerActionResult | ComputerActionError> {
    // Waiting for the lease can take up to 30 seconds, and typing long text takes a while.
    return this.call("POST", "/computer/action", { run, action }, 120_000);
  }

  /** The readable content of the page in front on a bot's screen. */
  read(run: RunIdentity, selector?: string): Promise<ComputerReadResult | ComputerActionError> {
    return this.call("POST", "/computer/read", { run, ...(selector && { selector }) }, 60_000);
  }

  /** Type a vault secret on a bot's screen. botd checks the site first, for logins. */
  fill(request: ComputerFillRequest): Promise<ComputerFillResult | ComputerActionError> {
    return this.call("POST", "/computer/fill", request, 60_000);
  }

  /** Start a bot's screen without using it, so you can watch it. */
  startScreen(screenId: string): Promise<unknown> {
    return this.call("POST", "/screens/start", { screenId });
  }

  /** A bot was removed: stop its screen and delete its browser profile. */
  forgetScreen(screenId: string): Promise<unknown> {
    return this.call("POST", "/screens/forget", { screenId });
  }

  releaseRun(runId: string): Promise<{ released: boolean }> {
    return this.call("POST", "/lease/run/release", { runId });
  }

  async takeByUser(screenId: string): Promise<{ previous: LeaseHolder; holder: LeaseHolder }> {
    const result = await this.call<{ previous: LeaseHolder; holder: LeaseHolder }>(
      "POST",
      "/lease/user/take",
      { screenId },
    );
    // Update right away, so your control connection is accepted without waiting for the event.
    this.setLease(screenId, result.holder, "preempted");
    return result;
  }

  private setLease(screenId: string, holder: LeaseHolder, reason: LeaseChangeReason) {
    const previous = this.lease(screenId);
    if (JSON.stringify(previous) === JSON.stringify(holder)) return;
    if (holder) this.leases.set(screenId, holder);
    else this.leases.delete(screenId);
    // botd sends health every few seconds; until then, show who holds the screen now.
    if (this.lastHealth?.screens.some((screen) => screen.id === screenId)) {
      this.lastHealth = {
        ...this.lastHealth,
        screens: this.lastHealth.screens.map((screen) =>
          screen.id === screenId ? { ...screen, lease: holder } : screen,
        ),
      };
    }
    this.emit("lease", screenId, holder, previous, reason);
  }

  releaseByUser(screenId: string, reason: LeaseReleaseReason): Promise<{ released: boolean }> {
    return this.call("POST", "/lease/user/release", { screenId, reason });
  }

  touchUser(screenId: string): Promise<unknown> {
    return this.call("POST", "/lease/user/touch", { screenId });
  }

  fetchHealth(): Promise<ComputerHealth> {
    return this.call("GET", "/health", undefined, 5_000);
  }
}
