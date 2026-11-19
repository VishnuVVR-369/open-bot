// The Codex app-server stream tap: every JSON-RPC message between the worker and Codex, both ways,
// saved through the writer with the run it belongs to. Streaming deltas are counted, not stored, and
// every payload is redacted before it is queued. It runs inside the connection's message handling,
// so there it does only constant work (the method, ids, run and order); the redaction, bounded by
// the message's size, runs afterwards, off that path. A message waiting for its redaction holds
// room in the writer's queue, so waiting payloads count toward its memory limit, and `drain()`
// finishes them at shutdown before the writer stops. Whatever fails is stored as a stub and
// counted as lost, never thrown into the connection.
import type { WireMessage, WireObserver } from "@open-bot/agent";
import {
  type AuthMode,
  type CodexEventRefs,
  codexEventRefs,
  isDeltaMethod,
  MAX_EVENT_SIZE,
  redactCodexPayload,
  UnstorablePayload,
} from "@open-bot/domain";
import type { CodexEventRow, ModelLogWriter } from "./writer";

/** The live runs, as the tap asks about them (the session registry). */
export interface TapRuns {
  /** The live run whose current thread this is. */
  runForThread(threadId: string): { runId: string; accessMode: AuthMode } | null;
  /** How a live run reaches the model, or null when it isn't live. */
  accessMode(runId: string): AuthMode | null;
}

export interface CodexEventTapOptions {
  writer: Pick<
    ModelLogWriter,
    "addEvent" | "addTurn" | "lostEvent" | "reserveEvent" | "releaseEvent"
  >;
  runs: TapRuns;
  /** The run the current async work is for (`../../core/run-scope.ts`). */
  currentRunId: () => string | undefined;
  now?: () => Date;
  /** Runs a message's redaction after the connection has handled it; `setImmediate` by default. */
  defer?: (work: () => void) => void;
}

/** How many turns, threads and counted items the tap remembers before forgetting the oldest. */
const REMEMBERED = 10_000;

/** A map that forgets its oldest entries past a size. */
class Recent<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    this.delete(key);
    super.set(key, value);
    if (this.size > REMEMBERED) this.delete(this.keys().next().value as K);
    return this;
  }
}

/** A request waiting for its response, with what its response inherits. */
interface OpenRequest {
  runId: string | null;
  refs: CodexEventRefs;
  at: Date;
}

/** Delta counts by item, per method, kept until the item or its turn completes. */
type Counts = Record<string, Record<string, number>>;

/** Streaming deltas counted per connection, by thread and turn, then by item. */
class DeltaCounter {
  private readonly turns = new Recent<string, Counts>();

  private static key(threadId: string | null, turnId: string | null) {
    return `${threadId ?? ""}\u0000${turnId ?? ""}`;
  }

  add(refs: CodexEventRefs, method: string) {
    const key = DeltaCounter.key(refs.threadId, refs.turnId);
    const counts = this.turns.get(key) ?? {};
    if (!this.turns.has(key)) this.turns.set(key, counts);
    const item = (counts[refs.itemId ?? ""] ??= {});
    item[method] = (item[method] ?? 0) + 1;
  }

  /** The counts of an item that completed, taken out. */
  takeItem(refs: CodexEventRefs): Counts | null {
    if (!refs.itemId) return null;
    const counts = this.turns.get(DeltaCounter.key(refs.threadId, refs.turnId));
    const item = counts?.[refs.itemId];
    if (!counts || !item) return null;
    delete counts[refs.itemId];
    return { [refs.itemId]: item };
  }

  /** The counts left in a turn that completed (items that never did), taken out. */
  takeTurn(refs: CodexEventRefs): Counts | null {
    const key = DeltaCounter.key(refs.threadId, refs.turnId);
    const counts = this.turns.get(key);
    this.turns.delete(key);
    return counts && Object.keys(counts).length ? counts : null;
  }
}

/** An error's name, never its message: a message could quote what it failed on. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a response is about: its result, if it has one. */
function responseBody(payload: unknown): unknown {
  return isRecord(payload) ? payload.result : null;
}

export class CodexEventTap {
  /**
   * Wire order across the worker's life: the start time in microseconds, then one per message.
   * Fewer than a million messages a second keeps it increasing across restarts.
   */
  private sequence = Date.now() * 1000;
  /** Turns a run started, to their run: a turn's messages stay its run's after the run ends. */
  private readonly turnRuns = new Recent<string, string>();
  /**
   * Threads a run asked about (started, forked, resumed), to the run: Codex's first messages on
   * a new thread arrive before the session knows its thread id.
   */
  private readonly threadRuns = new Recent<string, string>();
  private readonly now: () => Date;
  private readonly defer: (work: () => void) => void;
  /** Redactions deferred and not yet run, each holding room in the writer's queue. */
  private readonly waiting = new Set<() => void>();
  /** Set by `drain()`: from then on a message is redacted at once instead of deferred. */
  private drained = false;

  constructor(private readonly options: CodexEventTapOptions) {
    this.now = options.now ?? (() => new Date());
    this.defer = options.defer ?? ((work) => void setImmediate(work));
  }

  /** Messages waiting for their redaction. */
  get pending(): number {
    return this.waiting.size;
  }

  /**
   * Redacts and queues every message still waiting, now. Called at shutdown after Codex
   * disconnects and before the writer stops, so a message observed just before shutdown is
   * written instead of arriving at a stopped writer; anything observed later is handled at once.
   */
  drain(): void {
    this.drained = true;
    for (const work of [...this.waiting]) work();
  }

  /** An observer for one new connection, with that connection's open requests and deltas. */
  connection(): WireObserver {
    // A request whose response never comes (it timed out) is forgotten with the oldest.
    const open = new Recent<string, OpenRequest>();
    const deltas = new DeltaCounter();
    return (message) => this.observe(message, open, deltas);
  }

  /**
   * The run a message from Codex belongs to: the run that started its turn, else the live run on
   * its thread, else the live run that asked about its thread.
   */
  private runFor(refs: CodexEventRefs): string | null {
    const byTurn = refs.turnId ? this.turnRuns.get(refs.turnId) : undefined;
    if (byTurn) return byTurn;
    if (!refs.threadId) return null;
    const live = this.options.runs.runForThread(refs.threadId);
    if (live) return live.runId;
    const asked = this.threadRuns.get(refs.threadId);
    return asked && this.options.runs.accessMode(asked) ? asked : null;
  }

  private observe(message: WireMessage, open: Recent<string, OpenRequest>, deltas: DeltaCounter) {
    const at = this.now();
    try {
      this.capture(message, at, open, deltas);
    } catch (error) {
      this.options.writer.lostEvent(at, `a Codex message couldn't be read (${errorName(error)})`);
    }
  }

  private capture(
    message: WireMessage,
    at: Date,
    open: Recent<string, OpenRequest>,
    deltas: DeltaCounter,
  ) {
    if (message.kind === "notification" && isDeltaMethod(message.method)) {
      deltas.add(codexEventRefs(message.payload), message.method);
      return;
    }
    let refs = codexEventRefs(
      message.kind === "response" ? responseBody(message.payload) : message.payload,
    );
    let runId: string | null;
    let request: OpenRequest | undefined;
    if (message.kind === "response") {
      // A response answers a request that went the other way, and inherits its run and refs.
      const key = `${message.direction === "from_codex" ? "to_codex" : "from_codex"}:${message.id}`;
      request = open.get(key);
      open.delete(key);
      refs = {
        threadId: refs.threadId ?? request?.refs.threadId ?? null,
        turnId: refs.turnId ?? request?.refs.turnId ?? null,
        itemId: request?.refs.itemId ?? refs.itemId,
      };
      runId = request?.runId ?? null;
    } else if (message.direction === "to_codex") {
      // The worker's own request: the run whose work sent it, else the run on its thread.
      runId = this.options.currentRunId() ?? this.runFor(refs);
    } else {
      runId = this.runFor(refs);
    }
    if (runId && refs.threadId && message.direction === "to_codex")
      this.threadRuns.set(refs.threadId, runId);
    if (runId && refs.threadId && message.kind === "response" && message.direction === "from_codex")
      this.threadRuns.set(refs.threadId, runId);
    if (runId && refs.turnId) this.turnRuns.set(refs.turnId, runId);
    if (message.kind === "request")
      open.set(`${message.direction}:${message.id}`, { runId, refs, at });

    if (
      message.kind === "response" &&
      message.direction === "from_codex" &&
      message.method === "turn/start" &&
      runId &&
      refs.threadId &&
      refs.turnId
    )
      this.turnStarted(runId, refs.threadId, refs.turnId, request?.at ?? at);

    let deltaCounts: CodexEventRow["deltaCounts"] = null;
    if (message.kind === "notification" && message.method === "item/completed")
      deltaCounts = deltas.takeItem(refs);
    else if (message.kind === "notification" && message.method === "turn/completed")
      deltaCounts = deltas.takeTurn(refs);

    this.sequence += 1;
    const row: CodexEventRow = {
      runId,
      codexThreadId: refs.threadId,
      codexTurnId: refs.turnId,
      itemId: refs.itemId,
      sequence: this.sequence,
      direction: message.direction,
      kind: message.kind,
      method: message.method,
      rpcId: message.id === null ? null : String(message.id),
      payload: null,
      deltaCounts,
      at,
    };
    if (message.size > MAX_EVENT_SIZE) {
      this.stub(row, message.size, "it was too large to store");
      return;
    }
    const { method, payload, size } = message;
    const writer = this.options.writer;
    const refused = writer.reserveEvent(size);
    if (refused) {
      this.stub(row, size, refused);
      return;
    }
    const work = () => {
      // Run once: by its deferral or by `drain()`, whichever comes first.
      if (!this.waiting.delete(work)) return;
      writer.releaseEvent(size);
      try {
        writer.addEvent({ ...row, payload: redactCodexPayload(method, payload) }, size);
      } catch (error) {
        this.stub(
          row,
          size,
          error instanceof UnstorablePayload
            ? error.message
            : `redacting it failed (${errorName(error)})`,
        );
      }
    };
    this.waiting.add(work);
    if (this.drained) work();
    else this.defer(work);
  }

  /**
   * A message whose payload can't be stored: its row keeps the method, ids, run and order, with
   * why and how large it was in place of the payload, and it is counted as lost.
   */
  private stub(row: CodexEventRow, size: number, why: string) {
    const reason = `a Codex message's payload wasn't stored: ${why}`;
    // A stub the writer drops is counted as lost there, once.
    if (this.options.writer.addEvent({ ...row, payload: { omitted: why, size } }, 256))
      this.options.writer.lostEvent(row.at, reason);
  }

  /** `turn/start` returned: the run has a new turn, on the access mode it is using now. */
  private turnStarted(runId: string, threadId: string, turnId: string, startedAt: Date) {
    const accessMode = this.options.runs.accessMode(runId);
    if (!accessMode) return;
    this.options.writer.addTurn({
      runId,
      codexThreadId: threadId,
      codexTurnId: turnId,
      accessMode,
      startedAt,
    });
  }
}
