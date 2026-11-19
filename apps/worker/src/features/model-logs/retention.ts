import { createDb, LOCKS, ownerSettings, withTryLock } from "@open-bot/db";
import {
  EXPIRED_ERROR_CHARS,
  EXPIRED_ITEM_FIELDS,
  expiredParams,
  retentionCutoff,
} from "@open-bot/domain";
import type pg from "pg";
import { WorkerError } from "../../core/errors";
import { errorMessage, type Logger } from "../../logger";

/**
 * The model log retention sweep. Once a day (and when the owner changes the window) it removes the
 * bodies of everything logged before the window: each request's items, instructions, tools,
 * response text, reasoning summary, raw response, tool call arguments and every parameter but
 * those that say how it was asked (`expiredParams`), and each Codex message's payload down to its
 * numbers and statuses. Then it deletes the blobs nothing names any more. Numbers, statuses, tool
 * names and links stay.
 *
 * It works in small batches, each its own short transaction, oldest first, so it never holds a
 * lock for long or blocks the writer, and stopping between batches leaves nothing half done: the
 * next sweep picks up where this one ended. One sweep runs at a time, in this worker (a running
 * sweep is shared) and across workers (an advisory lock; a second one skips).
 */

export interface RetentionOptions {
  /** Requests per batch: each brings its items, often a few hundred. */
  requestBatch: number;
  /** Codex messages per batch. */
  eventBatch: number;
  /** Blobs looked at per batch in the last pass, for any nothing names. */
  blobBatch: number;
  /** How long after start the first sweep runs, and how often after that. */
  firstAfterMs: number;
  everyMs: number;
  /** A pause between batches, so the writer's transactions go first. */
  pauseMs: number;
  now: () => Date;
  /** Called after each batch commits, with what it did. For tests. */
  onBatch?: (batch: { kind: BatchKind; rows: number; blobs: number }) => void;
}

const DEFAULTS: RetentionOptions = {
  requestBatch: 100,
  eventBatch: 500,
  blobBatch: 1000,
  firstAfterMs: 2 * 60_000,
  everyMs: 24 * 60 * 60_000,
  pauseMs: 50,
  now: () => new Date(),
};

/** What one sweep did. */
export interface SweepResult {
  /** Why it did nothing: bodies are kept forever, or another worker is sweeping. */
  skipped: "forever" | "busy" | null;
  cutoff: Date | null;
  requests: number;
  events: number;
  blobs: number;
  batches: number;
  /** Stopped by shutdown before it finished; the next sweep goes on from there. */
  interrupted: boolean;
}

/** Another worker holds the sweep's lock; this sweep skips. */
class SweepBusy extends WorkerError {
  constructor() {
    super(409, "Another worker is sweeping model logs.");
  }
}

/** A sweep's passes, in order: requests, then Codex messages, then blobs nothing names. */
type BatchKind = "requests" | "events" | "blobs";

/** How many times a blob delete is tried again when the writer named a blob meanwhile. */
const BLOB_ATTEMPTS = 3;
const FOREIGN_KEY_VIOLATION = "23503";

// The oldest requests that still have bodies, locked so a second sweep takes the next ones.
const NEXT_REQUESTS = `
  select id, params from model_requests
  where bodies_expired_at is null and started_at < $1
  order by started_at
  limit $2
  for update skip locked`;

// Expires the locked batch ($1), setting each request's parameters to those `expiredParams`
// keeps ($2, by id), and returns the blobs it freed.
const EXPIRE_REQUESTS = `
  with batch as (
    select id, instructions_hash, tools_hash from model_requests where id = any($1::uuid[])
  ),
  items as (
    delete from model_request_items i using batch b where i.request_id = b.id
    returning i.blob_hash
  ),
  calls as (
    update model_tool_calls c set arguments = null
    from batch b where c.request_id = b.id and c.arguments is not null
    returning 1
  ),
  expired as (
    update model_requests m set bodies_expired_at = $3, instructions_hash = null,
      tools_hash = null, response_text = null, reasoning_summary = null, raw_response = null,
      params = nullif($2::jsonb -> m.id::text, 'null'::jsonb)
    from batch b where m.id = b.id
    returning m.id
  )
  select (select count(*) from expired)::int as requests,
    coalesce((select array_agg(distinct hash) from (
      select blob_hash as hash from items
      union all select instructions_hash from batch
      union all select tools_hash from batch
    ) freed where hash is not null), '{}') as freed`;

// Blobs freed by the batch that nothing names any more. A blob the writer holds (it locks the
// blobs it reuses with FOR KEY SHARE until it commits) is skipped, and left for a later batch
// to free again, or kept because the writer named it.
const DELETE_ORPHANS = `
  delete from model_blobs where hash in (
    select hash from model_blobs b
    where hash = any($1::text[])
      and not exists (select 1 from model_request_items i where i.blob_hash = b.hash)
      and not exists (select 1 from model_requests m where m.instructions_hash = b.hash)
      and not exists (select 1 from model_requests m where m.tools_hash = b.hash)
    for update skip locked
  )`;

/** A Codex message's payload cut down to what isn't a body (see `EXPIRED_ITEM_FIELDS`). */
const EXPIRED_PAYLOAD = `
  case
    when e.payload is null then null
    when e.payload ? 'omitted' then e.payload
    else jsonb_strip_nulls(
      jsonb_build_object('expired', true)
      || (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(
            case when jsonb_typeof(e.payload) = 'object' then e.payload else '{}'::jsonb end
          ) f(k, v)
          where k in ('threadId', 'turnId', 'itemId', 'callId', 'tool', 'namespace', 'server', 'status')
            and jsonb_typeof(v) in ('string', 'number', 'boolean'))
      || case when jsonb_typeof(e.payload->'item') = 'object' then jsonb_build_object('item',
          (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(e.payload->'item') f(k, v)
            where k = any($3::text[]) and jsonb_typeof(v) in ('string', 'number', 'boolean'))
          || case
            when jsonb_typeof(e.payload->'item'->'error') = 'object' then jsonb_build_object('error',
              jsonb_build_object('message', left(coalesce(e.payload->'item'->'error'->>'message', 'Failed'), $4)))
            when jsonb_typeof(e.payload->'item'->'error') = 'string' and e.payload->'item'->>'error' <> ''
              then jsonb_build_object('error', left(e.payload->'item'->>'error', $4))
            else '{}'::jsonb end)
        else '{}'::jsonb end
      || case when jsonb_typeof(e.payload->'turn') = 'object' then jsonb_build_object('turn',
          jsonb_build_object('id', e.payload->'turn'->'id', 'status', e.payload->'turn'->'status'))
        else '{}'::jsonb end)
  end`;

// The next blobs older than the window, by hash: any nothing names were missed by an earlier
// batch (the writer held them then) or left by a batch the database refused.
const OLD_BLOBS = `
  select hash from model_blobs where hash > $1 and created_at < $2 order by hash limit $3`;

const EXPIRE_EVENTS = `
  with batch as (
    select id from codex_events
    where bodies_expired_at is null and at < $1
    order by at
    limit $2
    for update skip locked
  )
  update codex_events e set bodies_expired_at = $5, payload = ${EXPIRED_PAYLOAD}
  from batch b where e.id = b.id`;

export class ModelLogRetention {
  private readonly options: RetentionOptions;
  private running: Promise<SweepResult> | null = null;
  private again = false;
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Pick<Logger, "info" | "warn">,
    options: Partial<RetentionOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Sweep soon after start, then once a day. */
  start(): void {
    this.stopping = false;
    const first = setTimeout(() => this.kick(), this.options.firstAfterMs);
    const daily = setInterval(() => this.kick(), this.options.everyMs);
    first.unref();
    daily.unref();
    this.timers.push(first, daily);
  }

  /** No new sweeps, and the one running stops after its batch; resolves once it has. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await this.running?.catch(() => {});
  }

  /** Sweep now, in the background; if one is running, once more after it. */
  kick(): void {
    if (this.stopping) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.sweep().catch((error: unknown) =>
      this.log.warn("model log retention sweep failed", { error: errorMessage(error) }),
    );
  }

  /** One sweep; while one is running, that one. */
  sweep(): Promise<SweepResult> {
    this.running ??= this.sweepOnce().finally(() => {
      this.running = null;
      if (this.again && !this.stopping) {
        this.again = false;
        this.kick();
      }
    });
    return this.running;
  }

  private async sweepOnce(): Promise<SweepResult> {
    const result: SweepResult = {
      skipped: null,
      cutoff: null,
      requests: 0,
      events: 0,
      blobs: 0,
      batches: 0,
      interrupted: false,
    };
    const settings = await ownerSettings(createDb(this.pool));
    const now = this.options.now();
    result.cutoff = retentionCutoff(now, settings?.modelLogRetentionDays);
    if (!result.cutoff) return { ...result, skipped: "forever" };
    const cutoff = result.cutoff;
    try {
      await withTryLock(
        this.pool,
        LOCKS.modelLogRetention,
        () => new SweepBusy(),
        async () => {
          let lastHash = "";
          for (const kind of ["requests", "events", "blobs"] as const) {
            for (;;) {
              if (this.stopping) {
                result.interrupted = true;
                return;
              }
              let batch: { rows: number; blobs: number; last?: string };
              if (kind === "requests") batch = await this.expireRequests(cutoff, now);
              else if (kind === "events") batch = await this.expireEvents(cutoff, now);
              else batch = await this.collectBlobs(cutoff, lastHash);
              lastHash = batch.last ?? lastHash;
              result.batches += 1;
              if (kind !== "blobs") result[kind] += batch.rows;
              result.blobs += batch.blobs;
              this.options.onBatch?.({ kind, rows: batch.rows, blobs: batch.blobs });
              const size = {
                requests: this.options.requestBatch,
                events: this.options.eventBatch,
                blobs: this.options.blobBatch,
              }[kind];
              if (batch.rows < size) break;
              await new Promise((resolve) => setTimeout(resolve, this.options.pauseMs));
            }
          }
        },
      );
    } catch (error) {
      if (error instanceof SweepBusy) return { ...result, skipped: "busy" };
      throw error;
    }
    if (result.requests || result.events || result.blobs)
      this.log.info("model log bodies expired", {
        cutoff: cutoff.toISOString(),
        requests: result.requests,
        events: result.events,
        blobs: result.blobs,
        interrupted: result.interrupted,
      });
    return result;
  }

  /** One batch of requests and the blobs it freed, in one transaction. */
  private async expireRequests(cutoff: Date, now: Date): Promise<{ rows: number; blobs: number }> {
    return this.transaction(async (client) => {
      const batch = await client.query<{ id: string; params: unknown }>(NEXT_REQUESTS, [
        cutoff,
        this.options.requestBatch,
      ]);
      if (!batch.rows.length) return { rows: 0, blobs: 0 };
      const params = Object.fromEntries(
        batch.rows.map((row) => [row.id, expiredParams(row.params)]),
      );
      const { rows } = await client.query<{ requests: number; freed: string[] }>(EXPIRE_REQUESTS, [
        batch.rows.map((row) => row.id),
        JSON.stringify(params),
        now,
      ]);
      const { requests, freed } = rows[0] ?? { requests: 0, freed: [] };
      return { rows: requests, blobs: freed.length ? await this.deleteOrphans(client, freed) : 0 };
    });
  }

  /**
   * Deletes the freed blobs nothing names. The writer may have named one between this statement's
   * snapshot and its delete; the foreign key then refuses the delete, and it is tried again, under
   * a savepoint, with a fresh look.
   */
  private async deleteOrphans(client: pg.PoolClient, freed: string[]): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      await client.query("savepoint orphans");
      try {
        const { rowCount } = await client.query(DELETE_ORPHANS, [freed]);
        await client.query("release savepoint orphans");
        return rowCount ?? 0;
      } catch (error) {
        await client.query("rollback to savepoint orphans");
        const code = (error as { code?: string }).code;
        if (code !== FOREIGN_KEY_VIOLATION || attempt >= BLOB_ATTEMPTS) {
          if (code === FOREIGN_KEY_VIOLATION) return 0;
          throw error;
        }
      }
    }
  }

  /** One batch of the last pass: blobs older than the window that nothing names. */
  private async collectBlobs(
    cutoff: Date,
    after: string,
  ): Promise<{ rows: number; blobs: number; last?: string }> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ hash: string }>(OLD_BLOBS, [
        after,
        cutoff,
        this.options.blobBatch,
      ]);
      const hashes = rows.map((row) => row.hash);
      return {
        rows: hashes.length,
        blobs: hashes.length ? await this.deleteOrphans(client, hashes) : 0,
        last: hashes.at(-1),
      };
    });
  }

  private async expireEvents(cutoff: Date, now: Date): Promise<{ rows: number; blobs: number }> {
    return this.transaction(async (client) => {
      const { rowCount } = await client.query(EXPIRE_EVENTS, [
        cutoff,
        this.options.eventBatch,
        [...EXPIRED_ITEM_FIELDS],
        EXPIRED_ERROR_CHARS,
        now,
      ]);
      return { rows: rowCount ?? 0, blobs: 0 };
    });
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Never wait long on a row the writer or a reader holds; the batch is tried next sweep.
      await client.query("set local lock_timeout = '5s'");
      await client.query("set local statement_timeout = '60s'");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
