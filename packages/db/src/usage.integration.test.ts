import { randomUUID } from "node:crypto";
import { costMicros } from "@open-bot/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "./testing";
import { apiKeySpendMicros } from "./usage";

// Migration 0040 moves usage onto the model logs: it copies each run's usage_entries onto the run
// as legacy totals and keeps entries of deleted runs; from then on the cap counts those plus the
// model requests a worker marks as counted (counts_usage), which only a worker that no longer
// writes usage_entries does. These rows are written as the previous worker wrote them (it logged
// model requests and wrote usage_entries both), before 0040, then migrated.

const url = testDatabaseServer();

const OCTOBER = new Date("2026-10-01T00:00:00Z");
const NOVEMBER = new Date("2026-11-01T00:00:00Z");
const at = (iso: string) => new Date(iso);

/** Usage priced with the old per-run formula; cached tokens are multiples of ten, so it's exact. */
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
});

describe.skipIf(!url)("usage on the model logs (migration 0040)", () => {
  const database = testDatabase(url);
  const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
  const teammate = randomUUID();
  const chat = randomUUID();
  const ids = {
    legacyFallback: randomUUID(),
    legacyKey: randomUUID(),
    logged: randomUUID(),
    loggedBeforeTurns: randomUUID(),
    deleted: randomUUID(),
    deletedPlan: randomUUID(),
    deletedLogged: randomUUID(),
    late: randomUUID(),
    newWorker: randomUUID(),
    skewed: randomUUID(),
    rolledBack: randomUUID(),
    returned: randomUUID(),
    interrupted: randomUUID(),
  };
  /** What the cap read before 0040, per month. */
  const before = { october: 0, november: 0 };

  async function run(id: string, created: Date, thread: string | null, turn: string | null) {
    await q(
      `insert into runs (id, chat_id, bot_id, trigger, prompt, status, codex_thread_id, -- vocabulary: allow
         codex_turn_id, created_at, started_at, completed_at)
       values ($1, $2, $3, 'user', 'hi', 'completed', $4, $5, $6, $6, $6)`,
      [id, chat, teammate, thread, turn, created],
    );
  }

  async function entry(
    runId: string | null,
    keyRun: string,
    mode: "plan" | "api_key",
    tokens: ReturnType<typeof usage>,
    created: Date,
  ) {
    await q(
      `insert into usage_entries (run_id, bot_id, auth_mode, input_tokens, cached_input_tokens, -- vocabulary: allow
         output_tokens, cost_micros, idempotency_key, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        runId,
        teammate,
        mode,
        tokens.inputTokens,
        tokens.cachedInputTokens,
        tokens.outputTokens,
        mode === "api_key" ? costMicros(tokens) : 0,
        `run:${keyRun}:${mode}`,
        created,
      ],
    );
  }

  /**
   * A model request as the proxy logs it, priced per request. `counted` as a worker that no longer
   * writes usage_entries saves it; the previous worker (and 0039's schema) leaves it out.
   */
  async function request(
    route: "api" | "plan" | null,
    thread: string | null,
    turn: string | null,
    tokens: ReturnType<typeof usage>,
    started: Date,
    {
      source = "codex",
      cost,
      counted = false,
    }: { source?: string; cost?: number; counted?: boolean } = {},
  ) {
    await q(
      `insert into model_requests (source, route, transport, method, endpoint, codex_thread_id,
         codex_turn_id, teammate_id, status, started_at, ended_at, input_tokens,
         cached_input_tokens, output_tokens, cost_micros, request_headers
         ${counted ? ", counts_usage" : ""})
       values ($1, $2, 'http', 'POST', '/responses', $3, $4, $5, 200, $6, $6, $7, $8, $9, $10, '{}'
         ${counted ? ", true" : ""})`,
      [
        source,
        route,
        thread,
        turn,
        teammate,
        started,
        tokens.inputTokens,
        tokens.cachedInputTokens,
        tokens.outputTokens,
        cost ?? (route === "api" ? costMicros(tokens) : 0),
      ],
    );
  }

  /** A gap as a worker that keeps lost API key spend writes it. */
  async function gap(firstAt: Date, lastAt: Date, apiCost: number) {
    await q(
      `insert into model_log_gaps (first_at, last_at, requests, api_requests, api_cost_micros, reason)
       values ($1, $2, 1, 1, $3, 'lost')`,
      [firstAt, lastAt, apiCost],
    );
  }

  /** A run's turn, as run_turns records it. */
  async function turn(runId: string, thread: string, turnId: string, started: Date) {
    await q(
      `insert into run_turns (codex_thread_id, codex_turn_id, run_id, access_mode, started_at)
       values ($1, $2, $3, 'api_key', $4)`,
      [thread, turnId, runId, started],
    );
  }

  /** The cap's query before 0040. */
  async function oldSpend(since: Date) {
    const { rows } = await q(
      `select coalesce(sum(cost_micros), 0)::float8 as spend from usage_entries
       where auth_mode = 'api_key' and created_at >= $1`,
      [since],
    );
    return Number(rows[0].spend);
  }

  beforeAll(async () => {
    await database.create({ through: "0039_model_log_retention_search" });
    await q(
      `insert into bots (id, name, slug, role, color) values ($1, 'Kit', 'kit', 'Engineer', '#0ea5e9')`, // vocabulary: allow
      [teammate],
    );
    await q(`insert into chats (id, kind, title) values ($1, 'direct', 'Kit')`, [chat]);

    // October 31, before model logging: a run that fell back from the plan to the key.
    await run(ids.legacyFallback, at("2026-10-31T23:00:00Z"), "t-a", "turn-a");
    await entry(
      ids.legacyFallback,
      ids.legacyFallback,
      "plan",
      usage(8_000, 6_000, 300),
      at("2026-10-31T23:59:59.000Z"),
    );
    await entry(
      ids.legacyFallback,
      ids.legacyFallback,
      "api_key",
      usage(4_000, 1_000, 200),
      at("2026-10-31T23:59:59.001Z"),
    );
    // October 31, logged before run_turns existed: found by the run's own thread and turn.
    await run(ids.loggedBeforeTurns, at("2026-10-31T20:00:00Z"), "t-b", "turn-b");
    await entry(
      ids.loggedBeforeTurns,
      ids.loggedBeforeTurns,
      "api_key",
      usage(30_000, 20_000, 500),
      at("2026-10-31T20:05:00Z"),
    );
    await request("api", "t-b", "turn-b", usage(10_000, 0, 200), at("2026-10-31T20:01:00Z"));
    await request("api", "t-b", "turn-b", usage(20_000, 20_000, 300), at("2026-10-31T20:03:00Z"));

    // November, before model logging: the key only.
    await run(ids.legacyKey, at("2026-11-01T00:00:01Z"), "t-c", "turn-c");
    await entry(
      ids.legacyKey,
      ids.legacyKey,
      "api_key",
      usage(50_000, 40_000, 1_000),
      at("2026-11-01T00:01:00Z"),
    );
    // November, logged and in usage_entries both (between model logging's start and this PR):
    // a fallback whose plan turn and key turn are both in run_turns.
    await run(ids.logged, at("2026-11-03T10:00:00Z"), "t-d2", "turn-d2");
    await q(
      `insert into run_turns (codex_thread_id, codex_turn_id, run_id, access_mode, started_at)
       values ('t-d1', 'turn-d1', $1, 'plan', $2), ('t-d2', 'turn-d2', $1, 'api_key', $3)`,
      [ids.logged, at("2026-11-03T10:00:00Z"), at("2026-11-03T10:02:00Z")],
    );
    await request("plan", "t-d1", "turn-d1", usage(9_000, 0, 0), at("2026-11-03T10:01:00Z"));
    await request("api", "t-d2", "turn-d2", usage(12_000, 2_000, 400), at("2026-11-03T10:02:10Z"));
    await request("api", "t-d2", "turn-d2", usage(14_000, 12_000, 100), at("2026-11-03T10:03:00Z"));
    await entry(ids.logged, ids.logged, "plan", usage(9_000, 0, 0), at("2026-11-03T10:04:00Z"));
    await entry(
      ids.logged,
      ids.logged,
      "api_key",
      usage(26_000, 14_000, 500),
      at("2026-11-03T10:04:00Z"),
    );
    // A run deleted before 0040: its entries lost their run but still counted.
    await entry(null, ids.deleted, "api_key", usage(7_000, 0, 100), at("2026-11-05T09:00:00Z"));
    await entry(null, ids.deletedPlan, "plan", usage(5_000, 0, 50), at("2026-10-20T09:00:00Z"));
    // A logged run deleted before 0040: its entry lost its run, and its requests stay.
    await run(ids.deletedLogged, at("2026-11-04T08:00:00Z"), "t-e", "turn-e");
    await request("api", "t-e", "turn-e", usage(10_000, 0, 0), at("2026-11-04T08:01:00Z"));
    await entry(
      ids.deletedLogged,
      ids.deletedLogged,
      "api_key",
      usage(10_000, 0, 0),
      at("2026-11-04T08:02:00Z"),
    );
    await q(`delete from runs where id = $1`, [ids.deletedLogged]);
    // The memory AI's requests use their own key and never counted toward the cap.
    await request(null, null, null, usage(1_000, 0, 0), at("2026-11-06T00:00:00Z"), {
      source: "memory",
      cost: 999,
    });

    before.october = (await oldSpend(OCTOBER)) - (await oldSpend(NOVEMBER));
    before.november = await oldSpend(NOVEMBER);
    await database.migrate();
  });
  afterAll(async () => {
    await database.drop();
  });

  async function legacyOf(id: string) {
    const { rows } = await q(
      `select legacy_plan_input_tokens::int as plan_input, legacy_plan_cached_input_tokens::int as plan_cached,
         legacy_plan_output_tokens::int as plan_output, legacy_plan_cost_micros::int as plan_cost,
         legacy_api_key_input_tokens::int as api_input, legacy_api_key_cached_input_tokens::int as api_cached,
         legacy_api_key_output_tokens::int as api_output, legacy_api_key_cost_micros::int as api_cost,
         legacy_usage_at
       from runs where id = $1`,
      [id],
    );
    return rows[0];
  }

  it("copies each run's entries onto it, per access mode, timed by the API key entry", async () => {
    expect(await legacyOf(ids.legacyFallback)).toEqual({
      plan_input: 8_000,
      plan_cached: 6_000,
      plan_output: 300,
      plan_cost: 0,
      api_input: 4_000,
      api_cached: 1_000,
      api_output: 200,
      api_cost: costMicros(usage(4_000, 1_000, 200)),
      legacy_usage_at: at("2026-10-31T23:59:59.001Z"),
    });
    expect(await legacyOf(ids.legacyKey)).toMatchObject({
      plan_input: null,
      plan_cost: null,
      api_input: 50_000,
      api_cost: costMicros(usage(50_000, 40_000, 1_000)),
      legacy_usage_at: at("2026-11-01T00:01:00Z"),
    });
    // A run logged and in usage_entries keeps both; its usage is read from these (its worker left
    // its requests unmarked).
    expect(await legacyOf(ids.logged)).toMatchObject({ plan_input: 9_000, api_input: 26_000 });
  });

  it("keeps entries of deleted runs, with the run their key names", async () => {
    const { rows } = await q(
      `select source_key, run_id, teammate_id, access_mode, input_tokens::int, cost_micros::int, at
       from legacy_deleted_run_usage order by at`,
    );
    expect(rows).toEqual([
      {
        source_key: `run:${ids.deletedPlan}:plan`,
        run_id: ids.deletedPlan,
        teammate_id: teammate,
        access_mode: "plan",
        input_tokens: 5_000,
        cost_micros: 0,
        at: at("2026-10-20T09:00:00Z"),
      },
      {
        source_key: `run:${ids.deletedLogged}:api_key`,
        run_id: ids.deletedLogged,
        teammate_id: teammate,
        access_mode: "api_key",
        input_tokens: 10_000,
        cost_micros: costMicros(usage(10_000, 0, 0)),
        at: at("2026-11-04T08:02:00Z"),
      },
      {
        source_key: `run:${ids.deleted}:api_key`,
        run_id: ids.deleted,
        teammate_id: teammate,
        access_mode: "api_key",
        input_tokens: 7_000,
        cost_micros: costMicros(usage(7_000, 0, 100)),
        at: at("2026-11-05T09:00:00Z"),
      },
    ]);
  });

  it("counts the same API key spend as before, on either side of the month's start", async () => {
    // A logged run deleted before 0040 included: its entry counts, and its requests don't.
    expect(before.november).toBeGreaterThan(0);
    expect(before.october).toBeGreaterThan(0);
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(before.november);
    expect((await apiKeySpendMicros(database.db, OCTOBER)) - before.november).toBe(before.october);
  });

  it("copies an entry the previous worker writes during the deploy as it is written", async () => {
    // A run of the previous worker, finished after 0040: it has no model logs at all.
    await run(ids.late, at("2026-11-08T10:00:00Z"), "t-f", "turn-f");
    await entry(ids.late, ids.late, "plan", usage(3_000, 0, 30), at("2026-11-08T10:01:00Z"));
    await entry(ids.late, ids.late, "api_key", usage(6_000, 0, 60), at("2026-11-08T10:02:00Z"));
    expect(await legacyOf(ids.late)).toMatchObject({
      plan_input: 3_000,
      api_input: 6_000,
      api_cost: costMicros(usage(6_000, 0, 60)),
      legacy_usage_at: at("2026-11-08T10:02:00Z"),
    });
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(await oldSpend(NOVEMBER));
  });

  it("counts a request through the worker that logged it, whatever its clock says", async () => {
    const spend = await oldSpend(NOVEMBER);
    // The new worker's clock 10 minutes behind the database's: its request still counts.
    await run(ids.newWorker, at("2026-11-12T09:00:00Z"), "t-g", "turn-g");
    await turn(ids.newWorker, "t-g", "turn-g", at("2026-11-12T09:00:00Z"));
    await request("api", "t-g", "turn-g", usage(40_000, 0, 1_000), at("2026-11-12T08:50:00Z"), {
      counted: true,
    });
    // The previous worker still finishing a run after the new one started, its clock ahead: its
    // entry counts the run, and its request never counts again.
    await run(ids.skewed, at("2026-11-12T09:20:00Z"), "t-h", "turn-h");
    await turn(ids.skewed, "t-h", "turn-h", at("2026-11-12T09:20:00Z"));
    await request("api", "t-h", "turn-h", usage(50_000, 0, 0), at("2026-11-12T09:30:00Z"));
    await entry(ids.skewed, ids.skewed, "api_key", usage(50_000, 0, 0), at("2026-11-12T09:31:00Z"));
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(
      spend + costMicros(usage(40_000, 0, 1_000)) + costMicros(usage(50_000, 0, 0)),
    );
  });

  it("counts each request once across a rollback to a worker that writes usage_entries, and back", async () => {
    const spend = await apiKeySpendMicros(database.db, NOVEMBER);
    // Rolled back: a run of a worker that writes usage_entries, logged and in usage_entries both.
    await run(ids.rolledBack, at("2026-11-13T09:00:00Z"), "t-r", "turn-r");
    await turn(ids.rolledBack, "t-r", "turn-r", at("2026-11-13T09:00:00Z"));
    await request("api", "t-r", "turn-r", usage(20_000, 0, 0), at("2026-11-13T09:01:00Z"));
    await entry(
      ids.rolledBack,
      ids.rolledBack,
      "api_key",
      usage(20_000, 0, 0),
      at("2026-11-13T09:02:00Z"),
    );
    // Such a worker writes gaps without their API key spend; its entries hold it.
    await q(
      `insert into model_log_gaps (first_at, last_at, requests, reason)
       values ($1, $1, 3, 'lost')`,
      [at("2026-11-13T09:03:00Z")],
    );
    // Back on a worker that counts from the model logs.
    await run(ids.returned, at("2026-11-14T09:00:00Z"), "t-s", "turn-s");
    await turn(ids.returned, "t-s", "turn-s", at("2026-11-14T09:00:00Z"));
    await request("api", "t-s", "turn-s", usage(30_000, 0, 0), at("2026-11-14T09:01:00Z"), {
      counted: true,
    });
    expect(await legacyOf(ids.rolledBack)).toMatchObject({ api_input: 20_000 });
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(
      spend + costMicros(usage(20_000, 0, 0)) + costMicros(usage(30_000, 0, 0)),
    );
  });

  it("counts nothing for a run the previous worker was running when it stopped, as before", async () => {
    // Interrupted on the previous worker: it logged a request but never wrote an entry, so the
    // old ledger counted none of it. Runs never resume on another worker, and the new worker
    // marks the run interrupted. The deploy precondition (no run in flight) keeps this from
    // happening.
    const spend = await apiKeySpendMicros(database.db, NOVEMBER);
    await run(ids.interrupted, at("2026-11-15T09:00:00Z"), "t-i", "turn-i");
    await turn(ids.interrupted, "t-i", "turn-i", at("2026-11-15T09:00:00Z"));
    await request("api", "t-i", "turn-i", usage(10_000, 0, 0), at("2026-11-15T09:01:00Z"));
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(spend);
  });

  it("counts a gap's API key spend in the month its requests started", async () => {
    const november = await apiKeySpendMicros(database.db, NOVEMBER);
    const october = await apiKeySpendMicros(database.db, OCTOBER);
    // Lost on October 31, saved in November.
    await gap(at("2026-10-31T23:59:59Z"), at("2026-10-31T23:59:59Z"), 3_000_000);
    await gap(at("2026-11-16T09:00:00Z"), at("2026-11-16T09:00:05Z"), 5_000);
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(november + 5_000);
    expect(await apiKeySpendMicros(database.db, OCTOBER)).toBe(october + 3_000_000 + 5_000);
  });

  it("never changes the month's spend when runs are deleted, logged or not", async () => {
    const deleted = [
      ids.legacyKey,
      ids.logged,
      ids.late,
      ids.newWorker,
      ids.rolledBack,
      ids.returned,
    ];
    const spend = await apiKeySpendMicros(database.db, NOVEMBER);
    await q(`delete from runs where id = any($1::uuid[])`, [deleted]);
    expect(await apiKeySpendMicros(database.db, NOVEMBER)).toBe(spend);
    const { rows } = await q(
      `select source_key, access_mode, cost_micros::int from legacy_deleted_run_usage
       where run_id = any($1::uuid[]) order by source_key collate "C"`,
      [deleted],
    );
    // Every run with legacy totals takes them along, under its entries' keys, logged or not (so
    // copying usage_entries again adds nothing); the new worker's runs have none, and their
    // requests stay.
    expect(rows).toEqual(
      [
        {
          source_key: `run:${ids.legacyKey}:api_key`,
          access_mode: "api_key",
          cost_micros: costMicros(usage(50_000, 40_000, 1_000)),
        },
        {
          source_key: `run:${ids.logged}:api_key`,
          access_mode: "api_key",
          cost_micros: costMicros(usage(26_000, 14_000, 500)),
        },
        { source_key: `run:${ids.logged}:plan`, access_mode: "plan", cost_micros: 0 },
        {
          source_key: `run:${ids.late}:api_key`,
          access_mode: "api_key",
          cost_micros: costMicros(usage(6_000, 0, 60)),
        },
        { source_key: `run:${ids.late}:plan`, access_mode: "plan", cost_micros: 0 },
        {
          source_key: `run:${ids.rolledBack}:api_key`,
          access_mode: "api_key",
          cost_micros: costMicros(usage(20_000, 0, 0)),
        },
      ].sort((a, b) => (a.source_key < b.source_key ? -1 : 1)),
    );
    // And the ledger still agrees, plus what the new worker spent and the gap it lost.
    expect(spend).toBe(
      (await oldSpend(NOVEMBER)) +
        costMicros(usage(40_000, 0, 1_000)) +
        costMicros(usage(30_000, 0, 0)) +
        5_000,
    );
  });
});
