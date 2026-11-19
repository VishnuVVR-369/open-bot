// Saves model logs in batches, off the request path: a request is queued in memory and the proxy
// moves on. The database being slow or down never holds up or fails a model request; what can't
// be saved in time is dropped and recorded as a gap once the database answers again.
import { EventEmitter } from "node:events";
import {
  bots, // vocabulary: allow
  type Db,
  errorFields,
  errorMessage,
  modelBlobs,
  modelLogGaps,
  modelRequestItems,
  modelRequests,
} from "@open-bot/db";
import { inArray } from "drizzle-orm";
import type { Logger } from "../../logger";
import type { ModelRequestRecord } from "./capture";

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

/** Requests that were lost, waiting to be recorded as one `model_log_gaps` row. */
interface PendingGap {
  firstAt: Date;
  lastAt: Date;
  requests: number;
  reason: string;
}

/** What the writer reports as it goes; tests wait on these instead of on time. */
export type ModelLogWriterEvents = {
  written: [requests: number];
  failed: [error: string];
  dropped: [requests: number, reason: string];
  gap: [requests: number];
};

/** Two sets of lost requests as one. */
function mergeGaps(gap: PendingGap | null, more: PendingGap | null): PendingGap | null {
  if (!gap || !more) return gap ?? more;
  return {
    firstAt: gap.firstAt < more.firstAt ? gap.firstAt : more.firstAt,
    lastAt: gap.lastAt > more.lastAt ? gap.lastAt : more.lastAt,
    requests: gap.requests + more.requests,
    // Each distinct reason once, so a long outage doesn't grow it without end.
    reason:
      gap.reason.includes(more.reason) || gap.reason.length > 2_000
        ? gap.reason
        : `${gap.reason}; ${more.reason}`,
  };
}

/** Postgres takes at most 65,535 parameters in one statement; rows go in slices well under it. */
const ROWS_PER_INSERT = 1_000;

function slices<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += ROWS_PER_INSERT)
    out.push(rows.slice(at, at + ROWS_PER_INSERT));
  return out;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Which of these teammates still exist. */
async function existingTeammates(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const table = bots; // vocabulary: allow
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(inArray(table.id, [...new Set(ids)]));
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
  private queue: ModelRequestRecord[] = [];
  private queuedBytes = 0;
  private gap: PendingGap | null = null;
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

  /** Queue one request. Never waits and never throws. */
  add(record: ModelRequestRecord): void {
    if (this.stopped) {
      this.drop([record], "the worker was shutting down");
      return;
    }
    if (this.queuedBytes + record.bytes > this.options.maxQueueBytes) {
      this.drop([record], "the log queue was full");
      return;
    }
    this.queue.push(record);
    this.queuedBytes += record.bytes;
    this.schedule(this.queue.length >= this.options.batchRows ? 0 : this.options.flushMs);
  }

  /** Records requests that never reached the queue, such as ones still running at shutdown. */
  lost(startedAt: Date[], reason: string): void {
    this.lose(
      startedAt.map((at) => at.getTime()),
      reason,
    );
  }

  /** Requests waiting to be written. */
  get pending(): number {
    return this.queue.length;
  }

  start(): void {}

  /** Writes what is queued once more, then stops; whatever still fails is lost. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.writing;
    if (!this.queue.length && !this.gap) return;
    try {
      while (this.queue.length || this.gap) await this.saveBatch();
    } catch (error) {
      this.log.warn("model logs were lost at shutdown", {
        ...errorFields(error),
        requests: this.queue.length,
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
    if (!this.queue.length && !this.gap) return;
    try {
      await this.saveBatch();
      this.failingSince = null;
      this.backoff = this.options.backoffMs;
      // A gap left by requests the database refused is written at once, with what is waiting.
      if (this.queue.length || this.gap)
        this.schedule(
          this.gap || this.queue.length >= this.options.batchRows ? 0 : this.options.flushMs,
        );
    } catch (error) {
      // The database can't be reached: the same rows are tried again, for a while.
      this.emit("failed", errorMessage(error));
      const now = Date.now();
      if (this.failingSince === null)
        this.log.warn("model logs could not be saved, retrying", {
          ...errorFields(error),
          requests: this.queue.length,
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
    // The gap being written is taken out, so requests lost meanwhile start a new one.
    const gap = this.gap;
    this.gap = null;
    try {
      await this.save(batch, gap);
      return;
    } catch (error) {
      this.gap = mergeGaps(gap, this.gap);
      if (!refusedRows(error) || !batch.length) throw error;
      this.log.warn("the database refused a batch of model logs, saving them one at a time", {
        ...errorFields(error),
        requests: batch.length,
      });
    }
    for (const record of batch) {
      try {
        await this.save([record], null);
      } catch (error) {
        if (!refusedRows(error)) throw error;
        this.dequeue([record]);
        this.drop([record], `the database refused it: ${errorMessage(error)}`);
      }
    }
  }

  /** Writes requests and a gap in one transaction, then takes the requests off the queue. */
  private async save(records: ModelRequestRecord[], gap: PendingGap | null): Promise<void> {
    if (!records.length && !gap) return;
    await this.db.transaction(async (tx) => {
      const blobs = new Map(
        records.flatMap((record) => record.blobs.map((blob) => [blob.hash, blob])),
      );
      // Most of a request's items were sent before: only new ones go over the wire.
      const known = new Set<string>();
      for (const hashes of slices([...blobs.keys()])) {
        const rows = await tx
          .select({ hash: modelBlobs.hash })
          .from(modelBlobs)
          .where(inArray(modelBlobs.hash, hashes));
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
      const requests = records.map((record) =>
        record.row.teammateId && !teammates.has(record.row.teammateId)
          ? { ...record.row, teammateId: null }
          : record.row,
      );
      for (const rows of slices(requests)) await tx.insert(modelRequests).values(rows);
      const items = records.flatMap((record) =>
        record.items.map((item) => ({ requestId: record.row.id, ...item })),
      );
      for (const rows of slices(items)) await tx.insert(modelRequestItems).values(rows);
      if (gap) await tx.insert(modelLogGaps).values(gap);
    });
    this.dequeue(records);
    if (gap) this.emit("gap", gap.requests);
    if (records.length) this.emit("written", records.length);
  }

  private dequeue(records: ModelRequestRecord[]) {
    const done = new Set(records);
    this.queue = this.queue.filter((record) => !done.has(record));
    for (const record of records) this.queuedBytes -= record.bytes;
  }

  /** Drops requests, to be recorded as a gap once the database answers. */
  private drop(records: ModelRequestRecord[], reason: string) {
    this.lose(
      records.map((record) => new Date(record.row.startedAt).getTime()),
      reason,
    );
  }

  /** Counts lost requests, by when each started, into the gap still to be written. */
  private lose(starts: number[], reason: string) {
    if (!starts.length) return;
    this.log.warn("model logs were dropped", { requests: starts.length, reason });
    this.gap = mergeGaps(this.gap, {
      firstAt: new Date(Math.min(...starts)),
      lastAt: new Date(Math.max(...starts)),
      requests: starts.length,
      reason,
    });
    this.emit("dropped", starts.length, reason);
    this.schedule(this.queue.length ? this.options.flushMs : this.backoff);
  }
}
