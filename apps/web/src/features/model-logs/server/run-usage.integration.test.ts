import { randomUUID } from "node:crypto";
import type { ApiClient, ChatData } from "@open-bot/api";
import { costMicros, type RunUsage } from "@open-bot/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { LogSeed } from "@/test/api/model-logs";
import { owned } from "@/test/api/seed";

// Each reply's footer, Settings' monthly usage and the API key spend count usage the same way:
// the legacy totals (from usage_entries, copied by migration 0040), plus the model requests the
// new worker marked as counted. Runs the previous worker finished have both, its requests
// unmarked, and count once, from their legacy totals; runs the new worker runs count from their
// logs. No time decides which, so clocks don't matter: the previous worker's requests are logged
// here after the new worker's.

/** A teammate's tokens, as the usage_entries readers summed them. */
const tokens = (mode: { input: number; output: number }) => mode.input + mode.output;
type Tokens = { input: number; cached: number; output: number };

describe.skipIf(!apiTestUrl)("usage from the model logs, through the API", () => {
  const harness = apiHarness();
  const { ids, database, answers } = harness;
  let api: ApiClient;
  let seed: LogSeed;
  // Recent enough to be this month, whenever the test runs (Settings counts this UTC month).
  const now = new Date(Date.now() - 1_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // The previous worker ran earlier this month; the new one ran a minute ago, by its clock.
  const before = new Date(Math.max(now.getTime() - 120_000, monthStart.getTime() + 1_000));
  const newWorker = new Date(Math.max(now.getTime() - 60_000, monthStart.getTime()));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
  const run = {
    legacy: randomUUID(),
    logged: randomUUID(),
    estimated: randomUUID(),
    both: randomUUID(),
    fallbackBeforeTurns: randomUUID(),
    none: randomUUID(),
    lastMonth: randomUUID(),
  };
  // A run the previous worker finished: its plan turn ran out, then its key turn.
  const legacyPlan = { input: 10_000, cached: 4_000, output: 300 };
  const legacyKey = { input: 6_000, cached: 2_000, output: 200 };
  const legacyKeyCost = costMicros({
    inputTokens: legacyKey.input,
    cachedInputTokens: legacyKey.cached,
    outputTokens: legacyKey.output,
  });
  // A run the new worker ran on the key: two requests, priced each on its own.
  const loggedRequests = [
    { input: 8_000, cached: 0, output: 400, cost: 20_000 },
    { input: 9_000, cached: 8_000, output: 100, cost: 3_800 },
  ];
  // A run the new worker ran whose request was cut off before its usage: estimated.
  const estimatedRequest = { input: 4_000, cached: 0, output: 500, cost: 13_000 };
  // The previous worker logged its runs too: those requests are already in the legacy totals.
  const oldEraRequest = { input: 5_000, cached: 1_000, output: 50, cost: 8_900 };
  // A fallback run from before run_turns: its plan turn's requests aren't found through it, only
  // its last (key) turn's. Its legacy totals hold both turns.
  const fallbackKeyRequest = { input: 2_000, cached: 0, output: 20, cost: 4_200 };
  // A run deleted before 0040: its entry is in legacy_deleted_run_usage, and its requests stay.
  const deleted = { input: 3_000, cached: 0, output: 30, cost: 6_300 };
  // A run the new worker ran and that was deleted since: only its requests are left.
  const deletedAfter = { input: 1_000, cached: 0, output: 10, cost: 2_100 };
  // API key requests the new worker lost after they finished, priced in their gap.
  const gapCost = 7_000;

  beforeAll(async () => {
    api = harness.api;
    seed = new LogSeed(database);
    const s = await import("@open-bot/db");
    const db = database.db;
    const row = (
      id: string,
      at: Date,
      thread: string | null = null,
      turn: string | null = null,
    ) => ({
      id,
      chatId: ids.chat,
      ...owned(ids.teammate),
      trigger: "user" as const,
      prompt: "Go",
      status: "completed" as const,
      codexThreadId: thread,
      codexTurnId: turn,
      createdAt: at,
      startedAt: at,
      completedAt: at,
    });
    const legacy = (plan: Tokens | null, key: Tokens | null, at: Date) => ({
      legacyPlanInputTokens: plan?.input ?? null,
      legacyPlanCachedInputTokens: plan?.cached ?? null,
      legacyPlanOutputTokens: plan?.output ?? null,
      legacyPlanCostMicros: plan ? 0 : null,
      legacyApiKeyInputTokens: key?.input ?? null,
      legacyApiKeyCachedInputTokens: key?.cached ?? null,
      legacyApiKeyOutputTokens: key?.output ?? null,
      legacyApiKeyCostMicros: key ? legacyKeyCost : null,
      legacyUsageAt: at,
    });
    await db.insert(s.runs).values([
      { ...row(run.legacy, before), ...legacy(legacyPlan, legacyKey, before) },
      { ...row(run.both, before), ...legacy(legacyPlan, legacyKey, before) },
      {
        ...row(run.fallbackBeforeTurns, before, "th-fb-key", "tu-fb-key"),
        ...legacy(legacyPlan, legacyKey, before),
      },
      row(run.logged, newWorker),
      row(run.estimated, newWorker),
      row(run.none, now),
      { ...row(run.lastMonth, lastMonth), ...legacy(legacyPlan, legacyKey, lastMonth) },
    ]);
    const turn = async (runId: string, thread: string, turnId: string, at: Date) =>
      db.insert(s.runTurns).values({
        runId,
        codexThreadId: thread,
        codexTurnId: turnId,
        accessMode: "api_key",
        startedAt: at,
      });
    await turn(run.logged, "th-logged", "tu-logged", newWorker);
    await turn(run.estimated, "th-estimated", "tu-estimated", newWorker);
    await turn(run.both, "th-both", "tu-both", before);
    const request = (
      thread: string,
      turnId: string,
      at: Date,
      tokens: Tokens & { cost: number },
      worker: "previous" | "new" = "new",
      usageEstimated = false,
    ) =>
      seed.request({
        threadId: thread,
        turnId,
        teammateId: ids.teammate,
        route: "api",
        at,
        tokens,
        costMicros: tokens.cost,
        countsUsage: worker === "new",
        usageEstimated,
      });
    for (const logged of loggedRequests) await request("th-logged", "tu-logged", newWorker, logged);
    await request("th-estimated", "tu-estimated", newWorker, estimatedRequest, "new", true);
    // The previous worker's requests, its clock ahead of the new worker's: they still count only
    // through its legacy totals.
    await request("th-both", "tu-both", now, oldEraRequest, "previous");
    await request("th-fb-key", "tu-fb-key", now, fallbackKeyRequest, "previous");
    await request("th-gone", "tu-gone", now, deleted, "previous");
    await request("th-gone-later", "tu-gone-later", newWorker, deletedAfter);
    // The memory AI's requests are no teammate's run, and use their own key.
    await seed.request({
      threadId: null,
      turnId: null,
      source: "memory",
      route: null,
      at: now,
      tokens: { input: 99_000, cached: 0, output: 9_000 },
      costMicros: 0,
    });
    await db.insert(s.legacyDeletedRunUsage).values({
      sourceKey: `run:${randomUUID()}:api_key`,
      teammateId: ids.teammate,
      accessMode: "api_key",
      inputTokens: deleted.input,
      cachedInputTokens: deleted.cached,
      outputTokens: deleted.output,
      costMicros: deleted.cost,
      at: before,
    });
    await db.insert(s.modelLogGaps).values({
      firstAt: now,
      lastAt: now,
      requests: 1,
      apiRequests: 1,
      apiCostMicros: gapCost,
      reason: "the database refused it",
    });
  });

  async function footers(): Promise<Record<string, RunUsage | null>> {
    const chat = await api.chats.get({ chatId: ids.chat });
    return Object.fromEntries(
      chat.entries.flatMap((entry: ChatData["entries"][number]) =>
        entry.type === "run" ? [[entry.run.id, entry.run.usage]] : [],
      ),
    );
  }

  const legacyTotal = {
    tokens: tokens(legacyPlan) + tokens(legacyKey),
    costMicros: legacyKeyCost,
    estimated: false,
  };

  it("shows a run the previous worker finished from its legacy totals, logged or not", async () => {
    const usage = await footers();
    // As the usage_entries reader summed it: input plus output of both modes, and their cost.
    expect(usage[run.legacy]).toEqual(legacyTotal);
    // Its requests were logged too, unmarked: not counted again.
    expect(usage[run.both]).toEqual(legacyTotal);
    // Both of its turns, though only its key turn's requests are found through it.
    expect(usage[run.fallbackBeforeTurns]).toEqual(legacyTotal);
  });

  it("shows a run the new worker ran from its requests", async () => {
    const usage = await footers();
    expect(usage[run.logged]).toEqual({
      tokens: loggedRequests.reduce((sum, request) => sum + tokens(request), 0),
      costMicros: loggedRequests.reduce((sum, request) => sum + request.cost, 0),
      estimated: false,
    });
    // And says when that includes an estimate.
    expect(usage[run.estimated]).toEqual({
      tokens: tokens(estimatedRequest),
      costMicros: estimatedRequest.cost,
      estimated: true,
    });
    expect(usage[run.none]).toBeNull();
  });

  it("counts each teammate's month once per run, through the worker that counted it", async () => {
    const rows = await api.settings.usage();
    const sum = (key: "input" | "cached" | "output") =>
      3 * (legacyPlan[key] + legacyKey[key]) +
      loggedRequests.reduce((total, request) => total + request[key], 0) +
      estimatedRequest[key] +
      deleted[key] +
      deletedAfter[key];
    expect(rows).toEqual([
      {
        botId: ids.teammate, // vocabulary: allow
        // Three legacy runs, the two logged ones, the one deleted before 0040, and the one
        // deleted since, by its turn; not last month's.
        runs: 7,
        inputTokens: sum("input"),
        cachedInputTokens: sum("cached"),
        outputTokens: sum("output"),
      },
    ]);
  });

  it("agrees across the footers, Settings and the cap", async () => {
    const usage = await footers();
    const shown = Object.values(usage).flatMap((value) => value ?? []);
    // What no footer shows: the runs deleted since, and the gap's priced requests.
    const gone = [deleted, deletedAfter];
    const [teammate] = await api.settings.usage();
    expect(teammate!.inputTokens + teammate!.outputTokens).toBe(
      shown.reduce((total, footer) => total + footer.tokens, 0) -
        // Last month's run has a footer, but isn't this month's.
        legacyTotal.tokens +
        gone.reduce((total, part) => total + tokens(part), 0),
    );
    const access = await api.settings.modelAccess();
    expect(access.spendMicros).toBe(
      shown.reduce((total, footer) => total + footer.costMicros, 0) -
        legacyTotal.costMicros +
        gone.reduce((total, part) => total + part.cost, 0) +
        gapCost,
    );
  });

  it("shows why the worker says the fallback is off", async () => {
    // A worker that doesn't say (deployed before it could) isn't taken to have it off.
    expect((await api.settings.modelAccess()).fallbackOff).toBeNull();

    const status = await fetchStatus();
    try {
      for (const reason of ["logging_off", "logs_unsaved"] as const) {
        answers.set("/internal/status", {
          status: 200,
          body: { ...status, apiFallbackOff: reason },
        });
        expect((await api.settings.modelAccess()).fallbackOff).toBe(reason);
      }
      answers.set("/internal/status", { status: 200, body: { ...status, apiFallbackOff: null } });
      expect((await api.settings.modelAccess()).fallbackOff).toBeNull();
    } finally {
      answers.delete("/internal/status");
    }
  });

  /** The stand-in worker's status, as it answers by default. */
  async function fetchStatus(): Promise<Record<string, unknown>> {
    const { worker } = await import("@/lib/server/worker");
    return (await worker.status.get()) as Record<string, unknown>;
  }
});
