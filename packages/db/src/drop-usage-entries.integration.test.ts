import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "./testing";
import { apiKeySpendMicros } from "./usage";

// Migration 0041 drops usage_entries, after copying it once more. These rows are what 0040, its
// triggers, the previous worker and the new one leave behind: a run 0040 copied; a run finished
// after it and an entry whose run was deleted, both written around 0040's copy trigger, which
// only 0041's copy picks up; a legacy run deleted after 0040, whose totals the delete trigger
// kept; a run 0040 copied whose requests the previous worker logged too (not counted), deleted
// before 0041; and a request the new worker counted.

const url = testDatabaseServer();

const MONTH = new Date("2026-11-01T00:00:00Z");
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("dropping usage_entries (migration 0041)", () => {
  const database = testDatabase(url);
  const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
  const teammate = randomUUID();
  const chat = randomUUID();
  const ids = {
    copied: randomUUID(),
    late: randomUUID(),
    lateDeleted: randomUUID(),
    loggedThenDeleted: randomUUID(),
  };
  const keptByTrigger = randomUUID();
  /** What the cap read from usage_entries just before 0041. */
  let ledgerSpend = 0;

  async function run(id: string, created: Date, legacyApiKey: number[] | null = null) {
    await q(
      `insert into runs (id, chat_id, bot_id, trigger, prompt, status, created_at, -- vocabulary: allow
         codex_thread_id, codex_turn_id,
         legacy_api_key_input_tokens, legacy_api_key_cached_input_tokens,
         legacy_api_key_output_tokens, legacy_api_key_cost_micros, legacy_usage_at)
       values ($1, $2, $3, 'user', 'hi', 'completed', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        chat,
        teammate,
        created,
        `thread-${id}`,
        `turn-${id}`,
        ...(legacyApiKey ?? [null, null, null, null]),
        legacyApiKey ? created : null,
      ],
    );
  }

  /**
   * An API key request as the proxy logs it, priced at `cost`; `counted` when the worker that
   * logged it counts usage from the model logs (the previous worker counted usage_entries).
   */
  async function request(
    thread: string,
    turn: string,
    cost: number,
    started: Date,
    counted: boolean,
  ) {
    await q(
      `insert into model_requests (source, route, transport, method, endpoint, codex_thread_id,
         codex_turn_id, status, started_at, ended_at, input_tokens, cached_input_tokens,
         output_tokens, cost_micros, counts_usage, request_headers)
       values ('codex', 'api', 'http', 'POST', '/responses', $1, $2, 200, $3, $3, 1000, 0, 0, $4,
         $5, '{}')`,
      [thread, turn, started, cost, counted],
    );
  }

  async function entry(
    runId: string | null,
    keyRun: string,
    mode: "plan" | "api_key",
    [input, cached, output, cost]: number[],
    created: Date,
  ) {
    await q(
      `insert into usage_entries (run_id, bot_id, auth_mode, input_tokens, cached_input_tokens, -- vocabulary: allow
         output_tokens, cost_micros, idempotency_key, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [runId, teammate, mode, input, cached, output, cost, `run:${keyRun}:${mode}`, created],
    );
  }

  beforeAll(async () => {
    await database.create({ through: "0040_usage_on_model_logs" });
    await q(
      `insert into bots (id, name, slug, role, color) values ($1, 'Kit', 'kit', 'Engineer', '#0ea5e9')`, // vocabulary: allow
      [teammate],
    );
    await q(`insert into chats (id, kind, title) values ($1, 'direct', 'Kit')`, [chat]);

    // Copied by 0040: its totals are on the run, and its entry is still there.
    await run(ids.copied, at("2026-11-02T10:00:00Z"), [6_000, 2_000, 200, 10_200]);
    await entry(
      ids.copied,
      ids.copied,
      "api_key",
      [6_000, 2_000, 200, 10_200],
      at("2026-11-02T10:00:00Z"),
    );
    // Written around 0040's copy trigger, so only usage_entries has them until 0041 copies.
    await q(`alter table usage_entries disable trigger usage_entries_copy_legacy`);
    // Finished by the previous worker after 0040 ran.
    await run(ids.late, at("2026-11-17T12:00:00Z"));
    await entry(ids.late, ids.late, "plan", [9_000, 3_000, 100, 0], at("2026-11-17T12:00:30Z"));
    await entry(
      ids.late,
      ids.late,
      "api_key",
      [5_000, 1_000, 300, 11_100],
      at("2026-11-17T12:01:00Z"),
    );
    // Written after 0040 for a run deleted since: the entry lost its run.
    await entry(
      null,
      ids.lateDeleted,
      "api_key",
      [1_000, 0, 10, 2_100],
      at("2026-11-17T12:05:00Z"),
    );
    await q(`alter table usage_entries enable trigger usage_entries_copy_legacy`);
    // A legacy run deleted after 0040: the trigger kept its totals, and its entry lost its run.
    await run(keptByTrigger, at("2026-11-03T09:00:00Z"), [3_000, 0, 30, 6_300]);
    await entry(
      keptByTrigger,
      keptByTrigger,
      "api_key",
      [3_000, 0, 30, 6_300],
      at("2026-11-03T09:00:00Z"),
    );
    await q(`delete from runs where id = $1`, [keptByTrigger]);
    // A run 0040 copied, whose requests the previous worker logged too (so they don't count),
    // deleted before 0041: its entry lost its run, and its requests stay.
    await run(ids.loggedThenDeleted, at("2026-11-05T09:00:00Z"));
    await entry(
      ids.loggedThenDeleted,
      ids.loggedThenDeleted,
      "api_key",
      [5_000, 0, 0, 10_000],
      at("2026-11-05T09:01:00Z"),
    );
    await request(
      `thread-${ids.loggedThenDeleted}`,
      `turn-${ids.loggedThenDeleted}`,
      10_000,
      at("2026-11-05T09:00:30Z"),
      false,
    );
    await q(`delete from runs where id = $1`, [ids.loggedThenDeleted]);
    // The new worker spent on the key.
    await request("thread-new", "turn-new", 4_000, at("2026-11-18T01:00:00Z"), true);

    const { rows } = await q(
      `select coalesce(sum(cost_micros), 0)::float8 as spend from usage_entries
       where auth_mode = 'api_key' and created_at >= $1`,
      [MONTH],
    );
    ledgerSpend = Number(rows[0].spend);
    await database.migrate();
  });
  afterAll(async () => {
    await database.drop();
  });

  it("copies a run the previous worker finished after 0040, and leaves copied ones as they were", async () => {
    const { rows } = await q(
      `select id, legacy_plan_input_tokens::int as plan_input, legacy_plan_cost_micros::int as plan_cost,
         legacy_api_key_input_tokens::int as api_input, legacy_api_key_cost_micros::int as api_cost,
         legacy_usage_at
       from runs order by created_at`,
    );
    expect(rows).toEqual([
      {
        id: ids.copied,
        plan_input: null,
        plan_cost: null,
        api_input: 6_000,
        api_cost: 10_200,
        legacy_usage_at: at("2026-11-02T10:00:00Z"),
      },
      {
        id: ids.late,
        plan_input: 9_000,
        plan_cost: 0,
        api_input: 5_000,
        api_cost: 11_100,
        legacy_usage_at: at("2026-11-17T12:01:00Z"),
      },
    ]);
  });

  it("keeps entries of deleted runs once, whether the trigger or the copy kept them", async () => {
    const { rows } = await q(
      `select source_key, run_id, cost_micros::int from legacy_deleted_run_usage order by at`,
    );
    expect(rows).toEqual([
      { source_key: `run:${keptByTrigger}:api_key`, run_id: keptByTrigger, cost_micros: 6_300 },
      {
        source_key: `run:${ids.loggedThenDeleted}:api_key`,
        run_id: ids.loggedThenDeleted,
        cost_micros: 10_000,
      },
      { source_key: `run:${ids.lateDeleted}:api_key`, run_id: ids.lateDeleted, cost_micros: 2_100 },
    ]);
  });

  it("counts the month's API key spend as usage_entries did, plus the new worker's, then drops it", async () => {
    expect(ledgerSpend).toBe(10_200 + 11_100 + 2_100 + 6_300 + 10_000);
    // The logged run deleted before 0041 counts once: the worker that logged its requests didn't
    // count them.
    expect(await apiKeySpendMicros(database.db, MONTH)).toBe(ledgerSpend + 4_000);
    const { rows } = await q(`select to_regclass('usage_entries') as table`);
    expect(rows[0].table).toBeNull();
    const functions = await q(
      `select proname from pg_proc where proname in ('copy_legacy_usage', 'usage_entries_copy_legacy')`,
    );
    expect(functions.rows).toEqual([]);
  });
});
