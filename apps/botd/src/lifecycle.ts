import type { ComputePhase } from "@open-bot/domain";
/** The computer declined to stop because work is still running. The controller retries later. */
export class ComputerBusy extends Error {}

/** botd never stops compute merely because its controller disconnected or its lease expired. */
export class ComputeLifecycle {
  private owner: { id: string; expires: number; demand: number } | null = null;
  private transition: Promise<void> | null = null;
  private phase: ComputePhase;
  private activity = 0;
  /** JSON-RPC requests, live turns, device login and server requests survive socket loss. */
  private readonly pending = new Set<string>();
  private readonly turns = new Set<string>();
  private readonly logins = new Set<string>();
  private unknown = false;

  constructor(
    readonly enabled: boolean,
    private readonly deps: {
      start(): Promise<void>;
      ready?(): boolean;
      stop(): Promise<void>;
      busy(): Promise<boolean>;
      now?: () => number;
    },
  ) {
    this.phase = enabled ? "idle" : "awake";
  }

  get status() {
    return { version: 1, enabled: this.enabled, phase: this.phase };
  }
  get hasWork(): boolean {
    return Boolean(
      this.owner?.demand ||
      this.activity ||
      this.pending.size ||
      this.turns.size ||
      this.logins.size ||
      this.unknown,
    );
  }

  get admitting(): boolean {
    return this.phase !== "stopping";
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  lease(id: string, demand: number): void {
    if (!this.enabled) throw new Error("Computer lifecycle disabled");
    if (!id || !Number.isSafeInteger(demand) || demand < 0)
      throw new Error("Invalid controller lease");
    if (
      this.owner &&
      this.owner.id !== id &&
      this.owner.expires > this.now() &&
      this.phase !== "idle"
    )
      throw new Error("Another worker owns this computer");
    if (this.phase === "stopping") throw new Error("Computer is stopping");
    this.owner = { id, demand, expires: this.now() + 45_000 };
  }

  private requireOwner(id: string) {
    if (!this.owner || this.owner.id !== id || this.owner.expires <= this.now())
      throw new Error("A current controller lease is required");
  }

  async ensure(id: string): Promise<void> {
    this.requireOwner(id);
    while (this.transition) await this.transition;
    if (this.phase === "awake" && this.deps.ready?.() !== false) return;
    this.phase = "starting";
    const starting = this.deps.start();
    this.transition = starting;
    try {
      await starting;
      this.phase = "awake";
    } catch (error) {
      this.phase = "idle";
      throw error;
    } finally {
      if (this.transition === starting) this.transition = null;
    }
  }

  begin(): () => void {
    if (!this.admitting) throw new Error("Computer is stopping; wake before retrying");
    this.activity++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activity--;
      }
    };
  }

  async quiesce(id: string): Promise<void> {
    this.requireOwner(id);
    if (this.transition) throw new Error("Computer lifecycle transition in progress");
    if (this.phase === "idle") return;
    // Close admission synchronously before the asynchronous busy check.
    this.phase = "stopping";
    const stopping = (async () => {
      const busy = {
        demand: this.owner!.demand,
        operations: this.activity,
        requests: this.pending.size,
        turns: this.turns.size,
        logins: this.logins.size,
        unknown: this.unknown,
        background: await this.deps.busy(),
      };
      if (Object.values(busy).some(Boolean))
        throw new ComputerBusy(
          `Computer still has active or unknown work: ${JSON.stringify(busy)}`,
        );
      await this.deps.stop();
      this.phase = "idle";
      // A successful full process shutdown is the only point where old RPC state can be forgotten.
      this.pending.clear();
      this.turns.clear();
      this.logins.clear();
      this.unknown = false;
    })();
    this.transition = stopping;
    try {
      await stopping;
    } catch (error) {
      this.phase = "awake";
      throw error;
    } finally {
      if (this.transition === stopping) this.transition = null;
    }
  }

  /** Observe both sides of every Codex bridge, without retaining prompts, credentials or codes. */
  rpc(connection: string, fromClient: boolean, data: string): void {
    if (!this.enabled) return;
    try {
      const message = JSON.parse(data) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      const key = `${connection}:${fromClient ? "client" : "server"}:${message.id}`;
      const other = `${connection}:${fromClient ? "server" : "client"}:${message.id}`;
      if (message.id !== undefined) {
        if (message.method) this.pending.add(key);
        else this.pending.delete(other);
      }
      const params = message.params ?? {};
      if (!fromClient && message.method === "turn/started") {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) this.turns.add(turn.id);
        else this.unknown = true;
      }
      if (!fromClient && message.method === "turn/completed") {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) this.turns.delete(turn.id);
      }
      if (
        fromClient &&
        message.method === "account/login/start" &&
        params.type === "chatgptDeviceCode"
      )
        this.logins.add(connection);
      if (!fromClient && message.method === "account/login/completed")
        this.logins.delete(connection);
      if (fromClient && message.method === "account/logout") this.logins.delete(connection);
    } catch {
      this.unknown = true;
    }
  }
}
