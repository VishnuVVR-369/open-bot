import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { teammates, runs, schedules, triggers } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../context";
import { allowRunsIn, refuseRunsIn } from "../../testing/refuse-runs";
import { ScheduleService } from "./schedules";
import { TriggerService } from "./triggers";

const url = testDatabaseServer();

/** The check start() runs on a timer, called directly to await it. */
const tick = (service: ScheduleService) => (service as unknown as { tick(): Promise<void> }).tick();

/**
 * What a page watch or a schedule saw is kept only together with the run it starts: a run that
 * can't be saved leaves the change or the due time for the next check.
 */
describe.skipIf(!url)("watches and schedules with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    env: { APP_URL: "https://openbot.test", WATCH_ALLOW_PRIVATE_URLS: true },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  let page = "";
  /** While set, page requests wait until this many have arrived, then all are answered. */
  let barrier: { size: number; waiting: (() => void)[] } | undefined;
  let server: Server;
  let pageUrl: string;
  let teammateId: string;

  beforeAll(async () => {
    await database.create();
    server = createServer((_request, response) => {
      const answer = () => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(page);
      };
      if (!barrier) return answer();
      barrier.waiting.push(answer);
      if (barrier.waiting.length < barrier.size) return;
      const release = barrier.waiting;
      barrier = undefined;
      for (const waiting of release) waiting();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`;
  });
  beforeEach(async () => {
    await pool.query("truncate bots, chats restart identity cascade"); // vocabulary: allow
    const [teammate] = await db
      .insert(teammates)
      .values({ name: "Otto", slug: "otto", role: "assistant", color: "#4f46e5" })
      .returning();
    teammateId = teammate!.id;
  });
  afterEach(async () => {
    barrier = undefined;
    await allowRunsIn(pool);
  });
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await database.drop();
  });

  it("finds a page's change again when the run it started couldn't be saved", async () => {
    const service = new TriggerService(ctx);
    const [watch] = await db
      .insert(triggers)
      .values({
        teammateId,
        kind: "watch",
        title: "Status page",
        prompt: "Tell me what changed.",
        url: pageUrl,
        intervalMinutes: 60,
        snapshot: "All systems normal",
        createdBy: "user",
      })
      .returning();
    page = "Degraded performance";

    await refuseRunsIn(pool);
    const failed = await service.checkNow(watch!.id).catch((error: unknown) => error);
    const [kept] = await db.select().from(triggers).where(eq(triggers.id, watch!.id));
    expect(kept!.snapshot).toBe("All systems normal");
    expect(failed).toMatchObject({ ok: false, changed: true });
    expect(kept!.lastError).toMatch(/couldn't start: relation "bots" does not exist/); // vocabulary: allow

    await allowRunsIn(pool);
    expect(await service.checkNow(watch!.id)).toMatchObject({ ok: true, changed: true });
    const fired = await db.select().from(runs).where(eq(runs.triggerId, watch!.id));
    expect(fired).toHaveLength(1);
    expect(fired[0]!.prompt).toContain("Degraded performance");
    const [after] = await db.select().from(triggers).where(eq(triggers.id, watch!.id));
    expect(after).toMatchObject({ snapshot: "Degraded performance", lastError: null });
    expect(after!.lastFiredAt).not.toBeNull();

    // Nothing new: no second run.
    expect(await service.checkNow(watch!.id)).toMatchObject({ ok: true, changed: false });
    expect(await db.select().from(runs).where(eq(runs.triggerId, watch!.id))).toHaveLength(1);
  });

  it("reports a change once when Check now and the timer look at the same time", async () => {
    const service = new TriggerService(ctx);
    const [watch] = await db
      .insert(triggers)
      .values({
        teammateId,
        kind: "watch",
        title: "Status page",
        prompt: "Tell me what changed.",
        url: pageUrl,
        intervalMinutes: 60,
        snapshot: "All systems normal",
        createdBy: "user",
      })
      .returning();
    page = "Degraded performance";
    // A check reads the watch's snapshot before it fetches the page, so holding the page until all
    // three asked for it means all three compare against the old snapshot.
    barrier = { size: 3, waiting: [] };
    const results = await Promise.all([
      service.checkNow(watch!.id),
      service.checkNow(watch!.id),
      service.checkNow(watch!.id),
    ]);
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(results.filter((result) => !result.changed)).toEqual([
      { ok: true, changed: false, summary: "Another check saw this first" },
      { ok: true, changed: false, summary: "Another check saw this first" },
    ]);
    expect(await db.select().from(runs).where(eq(runs.triggerId, watch!.id))).toHaveLength(1);

    // A check that read the old snapshot and fetched the old page doesn't put it back.
    const [after] = await db.select().from(triggers).where(eq(triggers.id, watch!.id));
    expect(after!.snapshot).toBe("Degraded performance");
  });

  it("keeps a schedule due when its run couldn't be saved, and runs it once after", async () => {
    const service = new ScheduleService(ctx);
    const due = new Date(Date.now() - 60_000);
    const [reminder] = await db
      .insert(schedules)
      .values({
        teammateId,
        title: "Pay rent",
        prompt: "Remind me to pay rent.",
        kind: "once",
        runAt: due,
        nextRunAt: due,
        timezone: "UTC",
        createdBy: "user",
      })
      .returning();
    const [other] = await db
      .insert(schedules)
      .values({
        teammateId,
        title: "Water plants",
        prompt: "Remind me to water the plants.",
        kind: "once",
        runAt: due,
        nextRunAt: due,
        timezone: "UTC",
        createdBy: "user",
      })
      .returning();

    await refuseRunsIn(pool);
    await tick(service).catch(() => {});
    expect(await db.select().from(runs)).toHaveLength(0);
    const [kept] = await db.select().from(schedules).where(eq(schedules.id, reminder!.id));
    expect(kept).toMatchObject({ enabled: true, nextRunAt: due, lastRunAt: null });
    expect(ctx.log.error).toHaveBeenCalledWith(
      "a schedule couldn't start its run",
      expect.objectContaining({ scheduleId: reminder!.id }),
    );

    await allowRunsIn(pool);
    await tick(service);
    await tick(service);
    const started = await db.select().from(runs);
    expect(started.map((run) => run.scheduleId).sort()).toEqual([reminder!.id, other!.id].sort());
    const [done] = await db.select().from(schedules).where(eq(schedules.id, reminder!.id));
    expect(done).toMatchObject({ enabled: false });
    expect(done!.lastRunAt).not.toBeNull();
  });
});
