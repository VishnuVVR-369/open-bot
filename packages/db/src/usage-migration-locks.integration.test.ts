import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type TestDatabase, testDatabase, testDatabaseServer } from "./testing";

// Migration 0040 runs while the previous worker still writes usage_entries and model logs, and runs
// are made and deleted. Those take its tables in different orders, so no one order of its own
// could avoid them all: it takes every lock it needs at once and never waits while holding one, so
// it is never part of a deadlock (which would abort the migration, and the deploy, or the app's
// write). Each test has the app's transaction hold one table, lets the migration wait, then has
// the transaction take another the migration needs.

const url = testDatabaseServer();

describe.skipIf(!url)("migration 0040 beside the previous worker's writes", () => {
  let database: TestDatabase;
  afterEach(async () => {
    await database.drop();
  });

  /** A database through 0039 with a teammate and a run, as the previous worker left it. */
  async function before() {
    database = testDatabase(url);
    await database.create({ through: "0039_model_log_retention_search" });
    const teammate = randomUUID();
    const chat = randomUUID();
    const run = randomUUID();
    await database.pool.query(
      `insert into bots (id, name, slug, role, color) values ($1, 'Kit', 'kit', 'Engineer', '#0ea5e9')`, // vocabulary: allow
      [teammate],
    );
    await database.pool.query(`insert into chats (id, kind, title) values ($1, 'direct', 'Kit')`, [
      chat,
    ]);
    await database.pool.query(
      `insert into runs (id, chat_id, bot_id, trigger, prompt, status) -- vocabulary: allow
       values ($1, $2, $3, 'user', 'hi', 'running')`,
      [run, chat, teammate],
    );
    return { teammate, run };
  }

  /**
   * Starts the migration and resolves once it waits for a lock the writer holds (or sleeps before
   * trying again), with the migration's promise in a record (an async function's returned promise
   * would be awaited).
   */
  async function migrateBlocked(): Promise<{ migration: Promise<void> }> {
    const migration = database.migrate();
    const failed = migration.then(
      () => "finished without waiting",
      (error: unknown) => `failed: ${String(error)}`,
    );
    for (;;) {
      const { rows } = await database.pool.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database()
           and (wait_event_type = 'Lock' or wait_event = 'PgSleep')`,
      );
      if ((rows[0]?.waiting ?? 0) > 0) return { migration };
      const done = await Promise.race([failed, new Promise((resolve) => setTimeout(resolve, 10))]);
      if (typeof done === "string") throw new Error(`The migration ${done}.`);
    }
  }

  it("never deadlocks with the previous worker writing its usage entries", async () => {
    const { teammate, run } = await before();
    const writer = await database.pool.connect();
    const entry = (runId: string | null, key: string) =>
      writer.query(
        `insert into usage_entries (run_id, bot_id, auth_mode, input_tokens, cached_input_tokens, -- vocabulary: allow
           output_tokens, cost_micros, idempotency_key)
         values ($1, $2, 'api_key', 1000, 0, 10, 2100, $3)`,
        [runId, teammate, key],
      );
    try {
      await writer.query("begin");
      await entry(null, `run:${randomUUID()}:api_key`);
      const { migration } = await migrateBlocked();
      // Its foreign key reads runs, which the migration would hold had it not waited first.
      await entry(run, `run:${run}:api_key`);
      await writer.query("commit");
      await migration;
    } finally {
      writer.release();
    }
    const { rows } = await database.pool.query(
      `select legacy_api_key_cost_micros::int as cost from runs where id = $1`,
      [run],
    );
    expect(rows).toEqual([{ cost: 2100 }]);
  });

  it("never deadlocks with the model log writer saving a batch", async () => {
    const { run } = await before();
    const writer = await database.pool.connect();
    try {
      await writer.query("begin");
      await writer.query(
        `insert into model_requests (source, route, transport, method, endpoint, codex_thread_id,
           codex_turn_id, status, started_at, request_headers)
         values ('codex', 'api', 'http', 'POST', '/responses', 't-1', 'turn-1', 200, now(), '{}')`,
      );
      const { migration } = await migrateBlocked();
      await writer.query(
        `insert into run_turns (codex_thread_id, codex_turn_id, run_id, access_mode, started_at)
         values ('t-1', 'turn-1', $1, 'api_key', now())`,
        [run],
      );
      await writer.query(
        `insert into model_log_gaps (first_at, last_at, requests, reason)
         values (now(), now(), 1, 'lost')`,
      );
      await writer.query("commit");
      await migration;
    } finally {
      writer.release();
    }
    const { rows } = await database.pool.query(
      `select count(*)::int as requests from model_requests where not counts_usage`,
    );
    expect(rows).toEqual([{ requests: 1 }]);
  });

  it("never deadlocks with a run being deleted", async () => {
    const { teammate, run } = await before();
    await database.pool.query(
      `insert into usage_entries (run_id, bot_id, auth_mode, input_tokens, cached_input_tokens, -- vocabulary: allow
         output_tokens, cost_micros, idempotency_key)
       values ($1, $2, 'api_key', 1000, 0, 10, 2100, $3)`,
      [run, teammate, `run:${run}:api_key`],
    );
    const deleting = await database.pool.connect();
    try {
      await deleting.query("begin");
      // The run is locked first, as its deletion does, then its entries are written (set null).
      await deleting.query("select id from runs where id = $1 for update", [run]);
      const { migration } = await migrateBlocked();
      await deleting.query("delete from runs where id = $1", [run]);
      await deleting.query("commit");
      await migration;
    } finally {
      deleting.release();
    }
    // Deleted before the migration copied its entry: the entry is kept by its key.
    const { rows } = await database.pool.query(
      `select source_key, cost_micros::int as cost from legacy_deleted_run_usage`,
    );
    expect(rows).toEqual([{ source_key: `run:${run}:api_key`, cost: 2100 }]);
  });
});
