import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  createDb,
  createPool,
  credentials,
  modelLogGaps,
  modelRequests,
  settings,
} from "@open-bot/db";
import { monthStart } from "@open-bot/domain";
import { encryptSecret } from "@open-bot/domain/server";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../../context";
import { type ModelRequestRecord, ModelLogWriter, type UnsavedApiSpend } from "../model-logs";
import { ModelAccess } from "./service";

const url = testDatabaseServer();
const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const quiet = { warn() {}, error() {} };

/** Which way runs reach the model, on a real database: the plan, the key, or not at all. */
describe.skipIf(!url)("model access", () => {
  const database = testDatabase(url);
  const { db, pool } = database;
  const access = (modelProxy: boolean, unsaved?: UnsavedApiSpend) =>
    new ModelAccess(
      {
        db,
        pool,
        env: { ENCRYPTION_KEY, MODEL_PROXY: modelProxy },
        events: new EventEmitter(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as Context,
      unsaved,
    );
  const writers: ModelLogWriter[] = [];
  const writer = (target = db, options: ConstructorParameters<typeof ModelLogWriter>[2] = {}) => {
    const made = new ModelLogWriter(target, quiet, { flushMs: 60_000, ...options });
    writers.push(made);
    return made;
  };
  const setCap = (monthlyCapMicros: number) =>
    db.update(settings).set({ monthlyCapMicros }).where(eq(settings.id, 1));
  const decision = async (unsaved?: UnsavedApiSpend) =>
    (await access(true, unsaved).decide()).decision;

  beforeAll(async () => {
    await database.create();
    // The plan ran out an hour from now, a key is saved, and the cap has room.
    await db.insert(settings).values({
      id: 1,
      monthlyCapMicros: 5_000_000,
      planLimitedUntil: new Date(Date.now() + 60 * 60_000),
    });
    await db.insert(credentials).values({
      kind: "openai_api_key",
      encrypted: encryptSecret("sk-test-key", ENCRYPTION_KEY),
      hint: "sk-…-key",
    });
  });
  afterAll(async () => {
    for (const made of writers) await made.stop();
    await database.drop();
  });

  it("continues on the API key while model logging is on", async () => {
    const { decision, apiKey } = await access(true).decide();
    expect(decision).toEqual({ mode: "api_key" });
    expect(apiKey).toBe("sk-test-key");
  });

  it("never picks the API key while model logging is off, and says why in plain words", async () => {
    const { decision } = await access(false).decide();
    expect(decision).toEqual({ mode: "blocked", reason: "logging_off" });
    expect(await access(false).fallbackOff()).toBe("logging_off");
    expect(ModelAccess.blockedMessage("logging_off", 0)).toContain(
      "The API key fallback is off while model logging is off",
    );
  });

  it("counts this month's API key spend from the model logs", async () => {
    const now = new Date();
    await db.insert(modelRequests).values([
      // This month, on the key.
      { ...request(now), route: "api", costMicros: 4_000_000 },
      // On the plan, and last month on the key: not this month's key spend.
      { ...request(now), route: "plan", costMicros: 0 },
      { ...request(lastMonth(now)), route: "api", costMicros: 9_000_000 },
      // Logged by a worker that wrote usage_entries, which counted it: never again here.
      { ...request(now), route: "api", costMicros: 8_000_000, countsUsage: false },
    ]);
    expect(await access(true).monthSpendMicros(now)).toBe(4_000_000);
    await db.insert(modelRequests).values({ ...request(now), route: "api", costMicros: 1_000_000 });
    // At the cap: the key stops too.
    expect(await decision()).toEqual({ mode: "blocked", reason: "cap_reached" });
  });

  it("counts API key spend still waiting in the writer's queue", async () => {
    // $5 is saved; $2 more is queued, with a minute until its batch is written.
    await setCap(6_000_000);
    const queued = writer();
    queued.add(apiRecord(2_000_000));
    expect(queued.pendingApiCostMicros(monthStart(new Date()))).toBe(2_000_000);
    expect(await access(true, queued).monthSpendMicros()).toBe(7_000_000);
    expect(await decision(queued)).toEqual({ mode: "blocked", reason: "cap_reached" });

    // Saved, it counts once, from the database.
    await queued.settle(10_000);
    expect(queued.pendingApiCostMicros(monthStart(new Date()))).toBe(0);
    expect(await access(true, queued).monthSpendMicros()).toBe(7_000_000);
    expect(await decision(queued)).toEqual({ mode: "blocked", reason: "cap_reached" });
  });

  it("keeps the spend of an API key request the database refused, in its gap", async () => {
    await setCap(100_000_000);
    const spend = await access(true).monthSpendMicros();
    const refusing = writer(db, { flushMs: 5 });
    const gap = once(refusing, "gap");
    // A value the table refuses: the request is dropped for good, and only its gap is saved.
    refusing.add(apiRecord(3_000_000, { source: "bogus" as "codex" }));
    await gap;
    expect(refusing.pendingApiCostMicros(monthStart(new Date()))).toBe(0);
    expect(refusing.apiTrouble(monthStart(new Date()))).toBeNull();
    const [saved] = await db
      .select()
      .from(modelLogGaps)
      .where(eq(modelLogGaps.apiCostMicros, 3_000_000));
    expect(saved).toMatchObject({ requests: 1, apiRequests: 1, apiCostMicros: 3_000_000 });
    expect(await access(true).monthSpendMicros()).toBe(spend + 3_000_000);

    // At the cap, with only that request's spend over it: the key stops.
    await setCap(spend + 2_000_000);
    expect(await decision(refusing)).toEqual({ mode: "blocked", reason: "cap_reached" });
  });

  it("pauses the key while API key logs can't be saved, and resumes once they are", async () => {
    await setCap(100_000_000);
    const spend = await access(true).monthSpendMicros();
    // The writer's own connection gives up on a lock after 100 ms, as on a database too busy to
    // take writes: it keeps the batch and tries again.
    const target = new URL(database.url);
    target.searchParams.set("options", "-c lock_timeout=100");
    const busyPool = createPool(target.toString(), {
      onIdleError: (error) => {
        throw error;
      },
    });
    const busy = writer(createDb(busyPool), { flushMs: 5, backoffMs: 20, maxBackoffMs: 50 });
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("lock table model_requests in exclusive mode");
      const failed = once(busy, "failed");
      busy.add(apiRecord(1_500_000));
      await failed;
      expect(busy.apiTrouble(monthStart(new Date()))).toBe("logs_unsaved");
      expect(await access(true, busy).fallbackOff()).toBe("logs_unsaved");
      expect(await decision(busy)).toEqual({ mode: "blocked", reason: "logs_unsaved" });
      expect(ModelAccess.blockedMessage("logs_unsaved", 0)).toContain(
        "The API key fallback is paused while model logs can't be saved",
      );
      // A writer with only plan requests waiting doesn't hold up the key.
      const planOnly = writer(createDb(busyPool), { flushMs: 5, backoffMs: 20 });
      const planFailed = once(planOnly, "failed");
      planOnly.add(apiRecord(0, { route: "plan" }));
      await planFailed;
      expect(planOnly.apiTrouble(monthStart(new Date()))).toBeNull();
      // Nor does one holding only last month's API key spend: it counts toward last month's.
      const lastMonthOnly = writer(createDb(busyPool), { flushMs: 5, backoffMs: 20 });
      const lastMonthFailed = once(lastMonthOnly, "failed");
      lastMonthOnly.add(apiRecord(700_000, { startedAt: lastMonth(new Date()) }));
      await lastMonthFailed;
      expect(lastMonthOnly.apiTrouble(monthStart(new Date()))).toBeNull();
      expect(await decision(lastMonthOnly)).toEqual({ mode: "api_key" });
      expect(lastMonthOnly.apiTrouble(monthStart(lastMonth(new Date())))).toBe("logs_unsaved");
      expect(lastMonthOnly.pendingApiCostMicros(monthStart(new Date()))).toBe(0);
      expect(lastMonthOnly.pendingApiCostMicros(monthStart(lastMonth(new Date())))).toBe(700_000);
      const written = once(busy, "written");
      await holder.query("commit");
      await written;
      await planOnly.settle(10_000);
      await lastMonthOnly.settle(10_000);
    } finally {
      holder.release();
    }
    expect(busy.apiTrouble(monthStart(new Date()))).toBeNull();
    expect(await decision(busy)).toEqual({ mode: "api_key" });
    expect(await access(true, busy).monthSpendMicros()).toBe(spend + 1_500_000);
    for (const made of writers.splice(writers.indexOf(busy))) await made.stop();
    await busyPool.end();
  });

  it("keeps the key on, and counts an estimate, for requests running when the worker stopped", async () => {
    await setCap(100_000_000);
    const spend = await access(true).monthSpendMicros();
    const lost = writer();
    // Still running when the worker shut down: priced from an estimate that errs high.
    lost.lost(
      [{ startedAt: new Date(), route: "api", costMicros: 250_000, estimated: true }],
      "the worker shut down before they finished",
    );
    expect(lost.apiTrouble(monthStart(new Date()))).toBeNull();
    expect(lost.pendingApiCostMicros(monthStart(new Date()))).toBe(250_000);
    expect(await access(true, lost).monthSpendMicros()).toBe(spend + 250_000);
    expect(await decision(lost)).toEqual({ mode: "api_key" });
    await lost.stop();
    const [saved] = await db
      .select()
      .from(modelLogGaps)
      .where(eq(modelLogGaps.reason, "the worker shut down before they finished"));
    expect(saved).toMatchObject({
      apiRequests: 1,
      apiRequestsEstimated: 1,
      apiCostMicros: 250_000,
    });
    expect(await access(true).monthSpendMicros()).toBe(spend + 250_000);
    expect(await decision()).toEqual({ mode: "api_key" });
  });

  it("counts lost API key spend in the month each request started, wherever it was saved", async () => {
    const now = new Date();
    const thisMonth = await access(true).monthSpendMicros(now);
    const before = await access(true).monthSpendMicros(lastMonth(now));
    const lost = writer();
    // Lost together, across the month's start: last month's request and this month's.
    lost.lost(
      [
        { startedAt: lastMonth(now), route: "api", costMicros: 400_000, estimated: false },
        { startedAt: now, route: "api", costMicros: 30_000, estimated: true },
      ],
      "the log queue was full",
    );
    expect(lost.pendingApiCostMicros(monthStart(now))).toBe(30_000);
    expect(lost.pendingApiCostMicros(monthStart(lastMonth(now)))).toBe(430_000);
    await lost.stop();
    const rows = await db
      .select()
      .from(modelLogGaps)
      .where(eq(modelLogGaps.reason, "the log queue was full"));
    expect(rows.map((row) => [row.firstAt < monthStart(now), row.apiCostMicros]).sort()).toEqual([
      [false, 30_000],
      [true, 400_000],
    ]);
    expect(await access(true).monthSpendMicros(now)).toBe(thisMonth + 30_000);
    // Since last month's start: last month's request and this month's.
    expect(await access(true).monthSpendMicros(lastMonth(now))).toBe(before + 430_000);
  });
});

/** Noon on the last day of the month before `now`'s. */
function lastMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
}

/** A request as a worker that counts usage from the model logs saved it. */
function request(startedAt: Date) {
  return {
    source: "codex" as const,
    transport: "http" as const,
    method: "POST",
    endpoint: "/responses",
    startedAt,
    requestHeaders: {},
    countsUsage: true,
  };
}

/**
 * An API key request as the proxy records it, priced at `costMicros`: without `counts_usage`,
 * which the writer sets as it saves it.
 */
function apiRecord(
  costMicros: number,
  row: Partial<ModelRequestRecord["row"]> = {},
): ModelRequestRecord {
  const { countsUsage: _, ...fields } = request(new Date());
  return {
    row: { id: randomUUID(), ...fields, route: "api", costMicros, ...row },
    blobs: [],
    items: [],
    toolCalls: [],
    bytes: 1_000,
  };
}
