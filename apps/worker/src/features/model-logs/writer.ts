// Saves model logs in batches, off the request path: model requests, Codex app-server messages and
// run turns are queued in memory and their producer moves on. The database being slow or down never
// holds up or fails a model request or a JSON-RPC message; what can't be saved in time is dropped
// and recorded as a gap once the database answers again.
//
// The monthly cap counts the API key's spend from these logs, so the writer also says what API
// key spend it holds that the database doesn't have yet (`pendingApiCostMicros`), and when it
// can't save it (`apiTrouble`). Every request it saves is marked as counted toward usage
// (`counts_usage`). A gap keeps the cost of the API key requests it lost, so their spend still
// counts once it is saved, and each gap holds the records of one calendar month (UTC), so that
// spend counts in the month its requests started.
import { EventEmitter } from "node:events";
import {
  codexEvents,
  type Db,
  errorFields,
  errorMessage,
  modelBlobs,
  modelLogGaps,
  modelRequestItems,
  modelRequests,
  modelToolCalls,
  runs,
  runTurns,
  teammates,
} from "@open-bot/db";
import type { FallbackOffReason } from "@open-bot/domain";
import { inArray } from "drizzle-orm";
import type { Logger } from "../../logger";
import type { LostRequest, ModelRequestRecord } from "./capture";
import {
  type LostRecord,
  type PendingGap,
  NONE_LOST,
  addCounts,
  gapRow,
  lostRequest,
  lostTotal,
  mergeGaps,
  monthOf,
} from "./gaps";

export interface ModelLogWriterOptions {
  /** How long a request may wait in the queue before a batch is written. */
  flushMs: number;
  /** A batch is written at once when this many requests are waiting. */
  batchRows: number;
  /** How long a batch is retried while the database can't be reached, before it is dropped. */
  retryForMs: number;
  /** What the queue may hold in memory; a request past it is dropped. */
  maxQueueBytes: number;
  /** The first wait after a failure; it doubles up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const WRITER_DEFAULTS: ModelLogWriterOptions = {
  flushMs: 1_000,
  batchRows: 100,
  retryForMs: 5 * 60_000,
  maxQueueBytes: 64 * 1024 * 1024,
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
};

/** A Codex app-server message as it is saved. */
export type CodexEventRow = typeof codexEvents.$inferInsert;
/** A run's turn as it is saved. */
export type RunTurnRow = typeof runTurns.$inferInsert;

/** One queued record: a model request, a Codex message or a run turn. */
type QueuedRecord =
  | { kind: "request"; record: ModelRequestRecord; at: number; bytes: number }
  | { kind: "event"; row: CodexEventRow; at: number; bytes: number }
  | { kind: "turn"; row: RunTurnRow; at: number; bytes: number };

/** Why the API key's spend held here can't be counted toward the cap right now. */
export type ApiSpendTrouble = Extract<FallbackOffReason, "logs_unsaved">;

/** What the cap reads from the writer: API key spend it holds that isn't saved yet. */
export type UnsavedApiSpend = Pick<ModelLogWriter, "pendingApiCostMicros" | "apiTrouble">;

/** What a run turn costs in the queue, beyond its strings. */
const TURN_BYTES = 256;
/** What a Codex event row costs in the queue besides its payload. */
const EVENT_ROW_BYTES = 512;

/** What the writer reports as it goes; tests wait on these instead of on time. */
export type ModelLogWriterEvents = {
  /** Records saved: model requests, Codex messages and run turns together. */
  written: [records: number];
  failed: [error: string];
  dropped: [records: number, reason: string];
  /** A gap row was saved for this many lost records. */
  gap: [records: number];
};

/** Postgres takes at most 65,535 parameters in one statement; rows go in slices well under it. */
const ROWS_PER_INSERT = 1_000;

function slices<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += ROWS_PER_INSERT)
    out.push(rows.slice(at, at + ROWS_PER_INSERT));
  return out;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Which of these runs still exist. */
async function existingRuns(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.id, [...new Set(ids)]));
  return new Set(rows.map((row) => row.id));
}

/** Which of these teammates still exist. */
async function existingTeammates(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx
    .select({ id: teammates.id })
    .from(teammates)
    .where(inArray(teammates.id, [...new Set(ids)]));
  return new Set(rows.map((row) => row.id));
}

/**
 * SQLSTATE classes that say the database could not do it now, not that it refuses these rows:
 * a lost connection (08), a rolled-back transaction (40), no resources (53), lock or state (55),
 * an administrator's shutdown (57) and system errors (58, XX).
 */
const TRANSIENT_CLASSES = new Set(["08", "40", "53", "55", "57", "58", "XX"]);

/**
 * The database answered and refused the rows themselves (a constraint, a value it won't store).
 * Sending the same rows again can't succeed, unlike a database that can't be reached.
 */
function refusedRows(error: unknown): boolean {
  const code = errorFields(error).code;
  return typeof code === "string" && code.length === 5 && !TRANSIENT_CLASSES.has(code.slice(0, 2));
}

export class ModelLogWriter extends EventEmitter<ModelLogWriterEvents> {
  private readonly options: ModelLogWriterOptions;
  private queue: QueuedRecord[] = [];
  private queuedBytes = 0;
  /** Room held for Codex messages still being redacted (`reserveEvent`). */
  private reservedBytes = 0;
  /** Lost records still to be saved, one gap per month. */
  private gaps = new Map<number, PendingGap>();
  /** The gaps being saved right now, taken out of `gaps`. */
  private savingGaps: PendingGap[] = [];
  /** Queued API key requests, and what they cost, by the month they started. */
  private queuedApi = new Map<number, { requests: number; costMicros: number }>();
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  private writing: Promise<void> | null = null;
  /** When the batch at the head of the queue first failed. */
  private failingSince: number | null = null;
  private backoff: number;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly log: Pick<Logger, "warn" | "error">,
    options: Partial<ModelLogWriterOptions> = {},
  ) {
    super();
    this.options = { ...WRITER_DEFAULTS, ...options };
    this.backoff = this.options.backoffMs;
  }

  /** Queue one model request. Never waits and never throws. */
  add(record: ModelRequestRecord): void {
    this.enqueue({
      kind: "request",
      record,
      at: new Date(record.row.startedAt).getTime(),
      bytes: record.bytes,
    });
  }

  /**
   * Queue one Codex app-server message; `bytes` is roughly what its payload holds. Never waits
   * and never throws. False when it was dropped (and counted as lost) instead.
   */
  addEvent(row: CodexEventRow, bytes: number): boolean {
    return this.enqueue({
      kind: "event",
      row,
      at: new Date(row.at).getTime(),
      bytes: EVENT_ROW_BYTES + bytes,
    });
  }

  /**
   * Holds room in the queue for a Codex message of `bytes` whose payload is redacted later, so
   * messages waiting for their redaction count toward the queue's limit as if queued. Null when
   * held, else why not (the queue is full, or the writer stopped). Each hold is given back with
   * `releaseEvent` right before its `addEvent`, so the room is there for it.
   */
  reserveEvent(bytes: number): string | null {
    if (this.stopped) return "the worker was shutting down";
    const need = EVENT_ROW_BYTES + bytes;
    if (this.queuedBytes + this.reservedBytes + need > this.options.maxQueueBytes)
      return "the log queue was full";
    this.reservedBytes += need;
    return null;
  }

  /** Gives back the room `reserveEvent` held for a message of `bytes`. */
  releaseEvent(bytes: number): void {
    this.reservedBytes = Math.max(0, this.reservedBytes - (EVENT_ROW_BYTES + bytes));
  }

  /** Queue one run turn. Never waits and never throws. */
  addTurn(row: RunTurnRow): void {
    this.enqueue({ kind: "turn", row, at: new Date(row.startedAt).getTime(), bytes: TURN_BYTES });
  }

  private enqueue(record: QueuedRecord): boolean {
    if (this.stopped) {
      this.drop([record], "the worker was shutting down");
      return false;
    }
    if (this.queuedBytes + this.reservedBytes + record.bytes > this.options.maxQueueBytes) {
      this.drop([record], "the log queue was full");
      return false;
    }
    this.queue.push(record);
    this.queuedBytes += record.bytes;
    this.countQueuedApi(record, 1);
    this.schedule(this.queue.length >= this.options.batchRows ? 0 : this.options.flushMs);
    return true;
  }

  /** Records requests that never reached the queue, such as ones still running at shutdown. */
  lost(requests: LostRequest[], reason: string): void {
    this.lose(
      requests.map((request) => ({
        at: request.startedAt.getTime(),
        counts: lostRequest(request.route, request.costMicros, request.estimated),
      })),
      reason,
    );
  }

  /**
   * Records a Codex message whose payload couldn't be stored (too large, too deep, or its
   * redaction failed); its row, if any, holds only a stub.
   */
  lostEvent(at: Date, reason: string): void {
    this.lose([{ at: at.getTime(), counts: { ...NONE_LOST, codexEvents: 1 } }], reason);
  }

  /**
   * Saves what is queued now without waiting for the next batch, and resolves once all of it is
   * saved or dropped, or after `timeoutMs`. While the database is failing it waits for the retry
   * already scheduled instead. Never throws.
   */
  settle(timeoutMs: number): Promise<void> {
    const waiting = new Set(this.queue);
    if (!waiting.size || this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!this.queue.some((record) => waiting.has(record))) done();
      };
      const done = () => {
        clearTimeout(timer);
        this.off("written", check);
        this.off("dropped", check);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.on("written", check);
      this.on("dropped", check);
      if (this.failingSince === null) this.schedule(0);
    });
  }

  /** Records waiting to be written. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * API key spend held here and not yet in the database, of requests that started at or after
   * `since` (the start of a month): queued requests, and requests lost into gaps that aren't saved
   * yet. Read it before the database's spend: a record saved between the two reads then counts
   * twice, never not at all.
   */
  pendingApiCostMicros(since: Date): number {
    const from = since.getTime();
    let total = 0;
    for (const [month, queued] of this.queuedApi) if (month >= from) total += queued.costMicros;
    for (const gap of [...this.gaps.values(), ...this.savingGaps])
      if (gap.month >= from) total += gap.apiCostMicros;
    return total;
  }

  /**
   * Why the API key spend held here since `since` (the start of a month) can't be counted toward
   * the cap, or null when it can: the database is failing to save it (`logs_unsaved`), so it would
   * be lost if the worker stopped. Spend of an earlier month never holds up this month's key.
   */
  apiTrouble(since: Date): ApiSpendTrouble | null {
    if (this.failingSince === null) return null;
    const from = since.getTime();
    const holdsApi =
      [...this.queuedApi].some(([month, queued]) => month >= from && queued.requests > 0) ||
      [...this.gaps.values(), ...this.savingGaps].some(
        (gap) => gap.month >= from && gap.apiRequests > 0,
      );
    return holdsApi ? "logs_unsaved" : null;
  }

  start(): void {}

  /** Writes what is queued once more, then stops; whatever still fails is lost. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.writing;
    if (!this.queue.length && !this.gaps.size) return;
    try {
      while (this.queue.length || this.gaps.size) await this.saveBatch();
    } catch (error) {
      this.log.warn("model logs were lost at shutdown", {
        ...errorFields(error),
        records: this.queue.length,
      });
    }
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    const at = Date.now() + ms;
    if (this.timer && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.writing ??= this.flush().finally(() => (this.writing = null));
    }, ms);
    this.timer.unref();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  /** One batch, then the next step: more batches, a retry, or nothing until the next request. */
  private async flush(): Promise<void> {
    if (!this.queue.length && !this.gaps.size) return;
    try {
      await this.saveBatch();
      this.failingSince = null;
      this.backoff = this.options.backoffMs;
      // A gap left by requests the database refused is written at once, with what is waiting.
      if (this.queue.length || this.gaps.size)
        this.schedule(
          this.gaps.size || this.queue.length >= this.options.batchRows ? 0 : this.options.flushMs,
        );
    } catch (error) {
      // The database can't be reached: the same rows are tried again, for a while.
      this.emit("failed", errorMessage(error));
      const now = Date.now();
      if (this.failingSince === null)
        this.log.warn("model logs could not be saved, retrying", {
          ...errorFields(error),
          records: this.queue.length,
        });
      this.failingSince ??= now;
      if (this.queue.length && now - this.failingSince >= this.options.retryForMs) {
        const batch = this.queue.slice(0, this.options.batchRows);
        this.dequeue(batch);
        this.drop(
          batch,
          `the database could not be reached for ${Math.round(this.options.retryForMs / 1000)} s: ${errorMessage(error)}`,
        );
        // The next batch gets its own time to be retried.
        this.failingSince = now;
      }
      this.schedule(this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs);
    }
  }

  /**
   * Saves the head of the queue with any pending gap. When the database refuses the rows
   * themselves, it saves them one at a time instead and drops only the ones it refuses, so one
   * bad request never holds up the rest. Throws only when the database can't be reached.
   */
  private async saveBatch(): Promise<void> {
    const batch = this.queue.slice(0, this.options.batchRows);
    // The gaps being written are taken out, so requests lost meanwhile start new ones.
    const gaps = [...this.gaps.values()];
    this.gaps = new Map();
    this.savingGaps = gaps;
    try {
      await this.save(batch, gaps);
      return;
    } catch (error) {
      for (const gap of gaps) this.gaps.set(gap.month, mergeGaps(this.gaps.get(gap.month), gap));
      this.savingGaps = [];
      if (!refusedRows(error) || !batch.length) throw error;
      this.log.warn("the database refused a batch of model logs, saving them one at a time", {
        ...errorFields(error),
        records: batch.length,
      });
    }
    for (const record of batch) {
      try {
        await this.save([record], []);
      } catch (error) {
        if (!refusedRows(error)) throw error;
        this.dequeue([record]);
        this.drop([record], `the database refused it: ${errorMessage(error)}`);
      }
    }
  }

  /** Writes records and gaps in one transaction, then takes the records off the queue. */
  private async save(queued: QueuedRecord[], gaps: PendingGap[]): Promise<void> {
    if (!queued.length && !gaps.length) return;
    const records = queued.flatMap((entry) => (entry.kind === "request" ? [entry.record] : []));
    const events = queued.flatMap((entry) => (entry.kind === "event" ? [entry.row] : []));
    const turns = queued.flatMap((entry) => (entry.kind === "turn" ? [entry.row] : []));
    await this.db.transaction(async (tx) => {
      const blobs = new Map(
        records.flatMap((record) => record.blobs.map((blob) => [blob.hash, blob])),
      );
      // Most of a request's items were sent before: only new ones go over the wire. The ones
      // reused are locked until commit, so the retention sweep can't delete one this batch is
      // about to name; one it deleted first reads as new and is written again.
      const known = new Set<string>();
      for (const hashes of slices([...blobs.keys()])) {
        const rows = await tx
          .select({ hash: modelBlobs.hash })
          .from(modelBlobs)
          .where(inArray(modelBlobs.hash, hashes))
          .for("key share");
        for (const row of rows) known.add(row.hash);
      }
      const fresh = [...blobs.values()]
        .filter((blob) => !known.has(blob.hash))
        .map((blob) => ({ ...blob, bytes: Buffer.byteLength(blob.content) }));
      for (const rows of slices(fresh))
        await tx.insert(modelBlobs).values(rows).onConflictDoNothing();
      // A teammate deleted since its request is no longer named; the request is still kept.
      const teammates = await existingTeammates(
        tx,
        records.flatMap((record) => record.row.teammateId ?? []),
      );
      // Every request counts toward usage: this worker writes no `usage_entries`.
      const requests = records.map((record) => ({
        ...record.row,
        countsUsage: true,
        ...(record.row.teammateId && !teammates.has(record.row.teammateId)
          ? { teammateId: null }
          : {}),
      }));
      for (const rows of slices(requests)) await tx.insert(modelRequests).values(rows);
      const items = records.flatMap((record) =>
        record.items.map((item) => ({ requestId: record.row.id, ...item })),
      );
      for (const rows of slices(items)) await tx.insert(modelRequestItems).values(rows);
      const calls = records.flatMap((record) =>
        record.toolCalls.map((call) => ({ requestId: record.row.id, ...call })),
      );
      for (const rows of slices(calls)) await tx.insert(modelToolCalls).values(rows);
      // A run deleted since (its chat was deleted) takes its messages and turns with it.
      const live = await existingRuns(tx, [
        ...events.flatMap((row) => row.runId ?? []),
        ...turns.map((row) => row.runId),
      ]);
      const keptEvents = events.filter((row) => !row.runId || live.has(row.runId));
      for (const rows of slices(keptEvents)) await tx.insert(codexEvents).values(rows);
      const keptTurns = turns.filter((row) => live.has(row.runId));
      for (const rows of slices(keptTurns))
        await tx.insert(runTurns).values(rows).onConflictDoNothing();
      if (gaps.length) await tx.insert(modelLogGaps).values(gaps.map(gapRow));
    });
    this.dequeue(queued);
    if (gaps.length) {
      this.savingGaps = [];
      this.emit(
        "gap",
        gaps.reduce((total, gap) => total + lostTotal(gap), 0),
      );
    }
    if (queued.length) this.emit("written", queued.length);
  }

  private dequeue(records: QueuedRecord[]) {
    const done = new Set(records);
    this.queue = this.queue.filter((record) => !done.has(record));
    for (const record of records) {
      this.queuedBytes -= record.bytes;
      this.countQueuedApi(record, -1);
    }
  }

  /** Adds a queued API key request's cost to its month's (`sign` 1), or takes it off (-1). */
  private countQueuedApi(record: QueuedRecord, sign: 1 | -1) {
    if (record.kind !== "request" || record.record.row.route !== "api") return;
    const month = monthOf(record.at);
    const queued = this.queuedApi.get(month) ?? { requests: 0, costMicros: 0 };
    const next = {
      requests: queued.requests + sign,
      costMicros: queued.costMicros + sign * (record.record.row.costMicros ?? 0),
    };
    if (next.requests > 0) this.queuedApi.set(month, next);
    else this.queuedApi.delete(month);
  }

  /** Drops records, to be recorded as gaps once the database answers. */
  private drop(records: QueuedRecord[], reason: string) {
    this.lose(
      records.map((record) => ({
        at: record.at,
        counts:
          record.kind === "request"
            ? lostRequest(
                record.record.row.route ?? null,
                record.record.row.costMicros ?? 0,
                record.record.row.usageEstimated ?? false,
              )
            : record.kind === "event"
              ? { ...NONE_LOST, codexEvents: 1 }
              : { ...NONE_LOST, runTurns: 1 },
      })),
      reason,
    );
  }

  /**
   * Counts lost records into the gaps still to be written: each into its own month's, by when it
   * was captured, so a gap never moves API key spend into another month.
   */
  private lose(records: LostRecord[], reason: string) {
    if (!records.length) return;
    this.log.warn("model logs were dropped", {
      ...records.reduce((counts, record) => addCounts(counts, record.counts), NONE_LOST),
      reason,
    });
    for (const record of records) {
      const month = monthOf(record.at);
      const at = new Date(record.at);
      this.gaps.set(
        month,
        mergeGaps(this.gaps.get(month), {
          month,
          firstAt: at,
          lastAt: at,
          ...record.counts,
          reason,
        }),
      );
    }
    this.emit("dropped", records.length, reason);
    this.schedule(this.queue.length ? this.options.flushMs : this.backoff);
  }
}
