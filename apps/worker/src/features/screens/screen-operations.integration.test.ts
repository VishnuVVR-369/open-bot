import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { bots, screenTakeovers, screenOperations, takeoverDeliveries } from "@open-bot/db";
import type { Context } from "../../context";
import type { TakeoverService } from "./takeovers";
import { withScreenLock } from "./screen-lock";
import { ScreenOperationService } from "./screen-operations";
import { TakeoverService as RealTakeoverService } from "./takeovers";
import { SessionRegistry } from "../../runs/registry";

const url = testDatabaseServer();
describe.skipIf(!url)("screen operations with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  let service: ScreenOperationService;
  let screenId: string;
  let takeoverId: string;
  const computer = { fetchHealth: vi.fn(), codeContext: vi.fn(), typeOnScreen: vi.fn() };
  const takeovers = { recordTake: vi.fn(), handBack: vi.fn() };
  const ctx = { db, pool, computer, events: new EventEmitter() } as unknown as Context;
  beforeAll(async () => {
    await database.create();
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    await pool.query("truncate bots cascade");
    await pool.query("truncate screen_operations");
    screenId = randomUUID();
    takeoverId = randomUUID();
    await db.insert(bots).values({
      id: screenId,
      name: "Screen test",
      slug: screenId,
      role: "Test",
      instructions: "Test",
      color: "#123456",
    });
    await db.insert(screenTakeovers).values({ id: takeoverId, screenId, status: "requested" });
    computer.fetchHealth.mockResolvedValue({ screens: [{ id: screenId, lease: null }] });
    computer.codeContext.mockResolvedValue({ site: "example.com" });
    computer.typeOnScreen.mockResolvedValue({ status: "needs_owner", reason: "Check the screen." });
    service = new ScreenOperationService(ctx, takeovers as unknown as TakeoverService);
  });
  afterAll(async () => {
    await database.drop();
  });
  const input = () => ({
    operationId: randomUUID(),
    takeoverId,
    expectedSite: "example.com",
    text: "582913",
    pressEnter: true,
  });

  it("records the operation before any computer call and types once across duplicates", async () => {
    const request = input();
    computer.fetchHealth.mockImplementation(async () => {
      expect(await service.get(request.operationId)).toMatchObject({ status: "received" });
      return { screens: [{ id: screenId, lease: null }] };
    });
    const results = await Promise.all([service.type(request), service.type(request)]);
    expect(results.some((r) => r.status === "needs_owner")).toBe(true);
    expect(computer.typeOnScreen).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select()
      .from(screenOperations)
      .where(eq(screenOperations.id, request.operationId));
    expect(JSON.stringify(row)).not.toContain(request.text);
    expect(Object.keys(row!)).not.toContain("text");
  });

  it("a cancellation tombstone prevents a delayed request from doing anything", async () => {
    const request = input();
    await service.cancel(request.operationId);
    expect((await service.type(request)).status).toBe("cancelled");
    expect(computer.fetchHealth).not.toHaveBeenCalled();
    expect(computer.typeOnScreen).not.toHaveBeenCalled();
  });

  it("rejects expired, ended, wrong-site, and owner-held requests without input", async () => {
    await db
      .update(screenTakeovers)
      .set({ createdAt: new Date(Date.now() - 601_000) })
      .where(eq(screenTakeovers.id, takeoverId));
    expect((await service.type(input())).status).toBe("failed");
    await db
      .update(screenTakeovers)
      .set({ createdAt: new Date(), status: "ended" })
      .where(eq(screenTakeovers.id, takeoverId));
    expect((await service.type(input())).status).toBe("failed");
    await db
      .update(screenTakeovers)
      .set({ status: "requested" })
      .where(eq(screenTakeovers.id, takeoverId));
    expect((await service.type({ ...input(), expectedSite: "other.example" })).status).toBe(
      "failed",
    );
    computer.fetchHealth.mockResolvedValue({
      screens: [{ id: screenId, lease: { kind: "user" } }],
    });
    expect((await service.type(input())).status).toBe("failed");
    expect(computer.typeOnScreen).not.toHaveBeenCalled();
  });

  it("a refusal from botd leaves the request open and records no takeover", async () => {
    computer.typeOnScreen.mockResolvedValue({ status: "failed", reason: "The site changed." });
    expect(await service.type(input())).toMatchObject({
      status: "failed",
      reason: "The site changed.",
    });
    expect(takeovers.recordTake).not.toHaveBeenCalled();
    const [request] = await db
      .select()
      .from(screenTakeovers)
      .where(eq(screenTakeovers.id, takeoverId));
    expect(request?.status).toBe("requested");
  });

  it("records the takeover with the holder botd actually preempted", async () => {
    const run = {
      kind: "run",
      runId: randomUUID(),
      botId: screenId,
      botName: "Screen test",
      since: new Date().toISOString(),
      lastActionAt: new Date().toISOString(),
    };
    computer.typeOnScreen.mockResolvedValue({
      status: "needs_owner",
      reason: "Check the screen.",
      previous: run,
    });
    expect((await service.type(input())).status).toBe("needs_owner");
    expect(takeovers.recordTake).toHaveBeenCalledWith(screenId, run);
  });

  it("a lost botd response still records the takeover so a hand-back reaches the bot", async () => {
    computer.typeOnScreen.mockRejectedValue(new Error("response lost"));
    expect((await service.type(input())).status).toBe("unknown");
    expect(takeovers.recordTake).toHaveBeenCalledWith(screenId, null);
  });

  it("another worker holding the per-screen lock prevents concurrent input", async () => {
    await withScreenLock(ctx, screenId, async () => {
      expect((await service.type(input())).status).toBe("failed");
    });
    expect(computer.typeOnScreen).not.toHaveBeenCalled();
  });

  it("lost botd responses become unknown without retry, and restarting cannot replay them", async () => {
    const request = input();
    computer.typeOnScreen.mockRejectedValue(new Error("response lost"));
    expect((await service.type(request)).status).toBe("unknown");
    await service.recover();
    await service.type(request);
    expect(computer.typeOnScreen).toHaveBeenCalledTimes(1);
    await db.insert(screenOperations).values({ id: randomUUID(), status: "verifying" });
    await service.recover();
    expect((await db.select().from(screenOperations)).every((r) => r.status === "unknown")).toBe(
      true,
    );
  });

  it("hands back only after a safe result; partial hand-back remains safe for reconciliation", async () => {
    const request = input();
    computer.typeOnScreen.mockResolvedValue({ status: "safe", reason: null });
    takeovers.handBack.mockRejectedValueOnce(new Error("database unavailable after release"));
    expect((await service.type(request)).status).toBe("safe");
    expect(takeovers.handBack).toHaveBeenCalledWith(
      screenId,
      "Entered the code you sent and submitted it.",
    );
    expect(JSON.stringify(await service.get(request.operationId))).not.toContain(request.text);
  });

  it("reconciles a released screen and a return whose delivery was interrupted", async () => {
    const realComputer = Object.assign(new EventEmitter(), {
      online: true,
      fetchHealth: vi.fn(async () => ({ screens: [] })),
    });
    const real = new RealTakeoverService(
      { ...ctx, computer: realComputer } as unknown as Context,
      new SessionRegistry(),
    );
    await db
      .update(screenTakeovers)
      .set({ status: "active", note: "Entered the code you sent and submitted it." })
      .where(eq(screenTakeovers.id, takeoverId));
    const operationId = randomUUID();
    await db
      .insert(screenOperations)
      .values({ id: operationId, takeoverId, screenId, status: "safe" });
    await real.reconcile();
    expect(
      (await db.select().from(screenTakeovers).where(eq(screenTakeovers.id, takeoverId)))[0],
    ).toMatchObject({ status: "ended" });
    expect((await service.get(operationId))?.status).toBe("handed_back");
    const [delivery] = await db
      .select()
      .from(takeoverDeliveries)
      .where(eq(takeoverDeliveries.id, takeoverId));
    expect(delivery?.deliveredAt).toBeInstanceOf(Date);
    await db
      .update(takeoverDeliveries)
      .set({ deliveredAt: null })
      .where(eq(takeoverDeliveries.id, takeoverId));
    await real.reconcile();
    expect(
      (await db.select().from(takeoverDeliveries).where(eq(takeoverDeliveries.id, takeoverId)))[0]
        ?.deliveredAt,
    ).toBeInstanceOf(Date);
    expect(
      (await db.select().from(takeoverDeliveries)).filter((row) => row.id === takeoverId),
    ).toHaveLength(1);
  });
});

describe.skipIf(!url)("takeover returns with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  const events = new EventEmitter();
  const health = { screens: [] as { id: string; lease: unknown }[] };
  const computer = Object.assign(new EventEmitter(), {
    online: true,
    fetchHealth: vi.fn(async () => health),
  });
  const ctx = { db, pool, computer, events } as unknown as Context;
  let screenId: string;
  beforeAll(async () => {
    await database.create();
  });
  beforeEach(async () => {
    await pool.query("truncate bots cascade");
    await pool.query("truncate notifications cascade");
    events.removeAllListeners();
    screenId = randomUUID();
    health.screens = [];
    await db.insert(bots).values({
      id: screenId,
      name: "Rex",
      slug: screenId,
      role: "Test",
      instructions: "Test",
      color: "#123456",
    });
  });
  afterAll(async () => {
    await database.drop();
  });

  it("delivers takeovers that ended together as one return", async () => {
    const service = new RealTakeoverService(ctx, new SessionRegistry());
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids)
      await db.insert(screenTakeovers).values({ id, screenId, status: "active" });
    const ended: string[] = [];
    events.on("takeoverEnded", (id: string) => ended.push(id));
    await service.reconcile();
    const deliveries = await db.select().from(takeoverDeliveries);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((d) => d.continuationRunId)).size).toBe(1);
    expect(deliveries.every((d) => d.deliveredAt instanceof Date)).toBe(true);
    expect(ended.sort()).toEqual([...ids].sort());
  });

  it("tells you each time a screen is paused for safety, not on every check", async () => {
    const service = new RealTakeoverService(ctx, new SessionRegistry());
    const paused = {
      id: screenId,
      lease: {
        kind: "user-code",
        since: new Date().toISOString(),
        lastInputAt: new Date().toISOString(),
        pausedForSafety: true,
      },
    };
    const titles: string[] = [];
    events.on("notification", (event: { title: string }) => titles.push(event.title));
    health.screens = [paused];
    await service.reconcile();
    await service.reconcile();
    expect(titles).toEqual(["Rex's screen is paused"]);
    health.screens = [];
    await service.reconcile();
    health.screens = [paused];
    await service.reconcile();
    expect(titles).toEqual(["Rex's screen is paused", "Rex's screen is paused"]);
  });
});
