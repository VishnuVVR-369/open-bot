import { EventEmitter } from "node:events";
import { BOTD_SOCKETS, BotdError, createBotdClient, type BotdClient } from "@open-bot/api/botd";
import {
  computerEventSchema,
  type CodeEntryResult,
  type ComputerAction,
  type ComputerActionError,
  type ComputerActionResult,
  type ComputerFillRequest,
  type ComputerFillResult,
  type ComputerHealth,
  type ComputerReadResult,
  type LeaseChangeReason,
  type LeaseHolder,
  type LeaseReleaseReason,
  type PageCheckError,
  type PageCheckResult,
  type RunIdentity,
  type ScreenStatus,
  type TypeOnScreen,
} from "@open-bot/domain";
import WebSocket from "ws";
import type { ComputerLifecycle } from "./lifecycle";
import { errorMessage, type Logger } from "../logger";

export { BotdError };

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
  lifecycle?: ComputerLifecycle;
  private generation = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1_000;
  /**
   * botd's API (`botdContract`). A call that works on the computer wakes it first, through the
   * lifecycle; the lifecycle's own calls (`botd.lifecycle.*`, `botd.healthz`) never do.
   */
  readonly botd: BotdClient;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log: Logger,
  ) {
    super();
    this.botd = createBotdClient({
      url: baseUrl,
      token,
      // While the lifecycle wakes or stops the computer, its calls stop when it gives up.
      signal: () => this.lifecycle?.signal,
      around: (call, next) =>
        call.meta.wakesComputer && this.lifecycle?.enabled && !this.lifecycle.inScope
          ? this.lifecycle.run(call.path, next)
          : next(),
    });
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
    if (!this.eventsSocket) this.connectEvents();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.eventsSocket;
    this.eventsSocket = null;
    socket?.terminate();
    this.lastHealth = null;
    this.leases.clear();
  }

  private connectEvents() {
    if (this.stopped) return;
    const generation = this.generation;
    const socket = new WebSocket(this.wsUrl(BOTD_SOCKETS.events), { handshakeTimeout: 10_000 });
    this.eventsSocket = socket;
    socket.on("open", () => {
      if (this.stopped || generation !== this.generation) {
        socket.terminate();
        return;
      }
      this.reconnectDelay = 1_000;
      this.log.info("connected to the computer");
      this.emit("connected");
    });
    socket.on("message", (data) => {
      if (this.stopped || generation !== this.generation || this.eventsSocket !== socket) return;
      const event = this.parseEvent(data.toString());
      if (!event) return;
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
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (generation === this.generation) this.connectEvents();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
      }
    });
    socket.on("error", (error) => {
      if (this.reconnectDelay <= 2_000) this.log.warn(`computer events: ${error.message}`);
    });
  }

  /** An event from botd, or null for one that doesn't fit the contract (logged, then skipped). */
  private parseEvent(data: string) {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch (error) {
      this.log.warn("computer sent an event that isn't JSON", { error: errorMessage(error) });
      return null;
    }
    const parsed = computerEventSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    // Only a string is logged as the type: the event is untrusted, so nothing else is converted.
    const type = typeof json === "object" && json && "type" in json ? json.type : undefined;
    this.log.warn("computer sent an event that doesn't fit the contract", {
      type: typeof type === "string" ? type : undefined,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
    return null;
  }

  action(
    run: RunIdentity,
    action: ComputerAction,
  ): Promise<ComputerActionResult | ComputerActionError> {
    // Waiting for the lease can take up to 30 seconds, and typing long text takes a while.
    return this.botd.computer.action({ run, action }, timeout(120_000));
  }

  /** The readable content of the page in front on a bot's screen. */
  read(run: RunIdentity, selector?: string): Promise<ComputerReadResult | ComputerActionError> {
    return this.botd.computer.read({ run, ...(selector && { selector }) }, timeout(60_000));
  }

  /** Type a vault secret on a bot's screen. botd checks the site first, for logins. */
  fill(request: ComputerFillRequest): Promise<ComputerFillResult | ComputerActionError> {
    return this.botd.computer.fill(request, timeout(60_000));
  }

  /**
   * Render a page file in a browser with no network, at a phone's width and a laptop's, and say
   * what's wrong with it. Returns the exact bytes it checked, for publishing.
   */
  checkPage(path: string): Promise<PageCheckResult | PageCheckError> {
    return this.botd.pages.check({ path }, timeout(90_000));
  }

  /** Start a bot's screen without using it, so you can watch it. */
  startScreen(screenId: string): Promise<ScreenStatus> {
    return this.botd.screens.start({ screenId }, timeout(180_000));
  }

  /** A bot was removed: stop its screen and delete its browser profile. */
  async forgetScreen(screenId: string): Promise<void> {
    await this.botd.screens.forget({ screenId });
  }

  releaseRun(runId: string): Promise<{ released: boolean }> {
    return this.botd.leases.releaseRun({ runId });
  }

  async takeByUser(screenId: string): Promise<{ previous: LeaseHolder; holder: LeaseHolder }> {
    const result = await this.botd.leases.take({ screenId }, timeout(180_000));
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

  releaseByUser(
    screenId: string,
    reason: LeaseReleaseReason,
    clearCode = false,
  ): Promise<{ released: boolean }> {
    return this.botd.leases.release({ screenId, reason, clearCode });
  }

  codeContext(screenId: string): Promise<{ site: string | null }> {
    return this.botd.computer.codeContext({ screenId });
  }

  typeOnScreen(screenId: string, input: TypeOnScreen): Promise<CodeEntryResult> {
    // Never retry this request. Unknown outcomes are resolved by the durable operation id.
    return this.botd.computer.type({ screenId, ...input }, timeout(45_000));
  }

  async touchUser(screenId: string): Promise<void> {
    await this.botd.leases.touch({ screenId });
  }

  fetchHealth(): Promise<ComputerHealth> {
    if (this.lifecycle?.enabled && !this.lifecycle.inScope) {
      if (this.lastHealth) return Promise.resolve(this.lastHealth);
      return Promise.reject(new Error("Computer is idle; status is cached"));
    }
    return this.botd.health(undefined, timeout(5_000));
  }
}

/** Call options that give up after `ms`. */
function timeout(ms: number) {
  return { context: { timeoutMs: ms } };
}
