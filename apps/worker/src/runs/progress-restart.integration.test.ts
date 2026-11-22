import { EventEmitter } from "node:events";
import { chats, runProgressNotifications, runs, teammates } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, WorkerEvents } from "../context";
import type { Run } from "../core/db-types";
import {
  END_OWED_FOR_MS,
  type NativePush,
  RunProgressService,
  runProgressStore,
  type RunProgressSnapshot,
} from "../features/notifications";
import { RunEventWriter } from "./events";
import { RunExecutor } from "./executor";
import { complete, type FinalizeSession } from "./session/finalize";

const url = testDatabaseServer();

/**
 * A run's progress notification ends on your phones even when the worker stops before it sends
 * the end: after storing the run's last status, or while the run was still going.
 */
describe.skipIf(!url)("run progress across a worker restart", () => {
  const database = testDatabase(url);
  const { db, pool } = database;
  const sent: NativePush[] = [];
  const fcm = {
    configured: true,
    async deliver(push: NativePush) {
      sent.push(push);
      return { sent: 1, failed: 0 };
    },
  };
  const timing = {
    showAfterMs: 10,
    stepEveryMs: 10,
    statusEveryMs: 10,
    keepAliveMs: 60_000,
    endRetryMs: [],
  };

  /** One worker process: its own events, and the progress service listening to them. */
  function worker() {
    const events = new EventEmitter<WorkerEvents>();
    const ctx = {
      db,
      pool,
      events,
      computer: { releaseRun: vi.fn(async () => {}) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Context;
    const snapshot: RunProgressSnapshot = {
      teammateId: "t",
      teammateName: "Kit",
      chatId: "c",
      status: "running",
      waitingFor: null,
      items: [],
    };
    const progress = new RunProgressService(ctx, fcm, () => snapshot, runProgressStore(db), timing);
    return { ctx, events, progress };
  }

  async function until(predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 200 && !(await predicate()); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await predicate()).toBe(true);
  }

  async function newRun(): Promise<Run> {
    const [teammate] = await db
      .insert(teammates)
      .values({
        name: "Kit",
        slug: `kit-${sent.length}-${Math.random()}`,
        role: "x",
        color: "#0ea5e9",
      })
      .returning();
    const [chat] = await db.insert(chats).values({ kind: "direct", title: "Kit" }).returning();
    const [run] = await db
      .insert(runs)
      .values({
        chatId: chat!.id,
        teammateId: teammate!.id,
        trigger: "user",
        prompt: "Take a while.",
        status: "running",
      })
      .returning();
    return run!;
  }

  const ends = (runId: string) =>
    sent.filter((push) => push.data.runId === runId && push.data.runState === "ended");
  const owed = async (runId: string) =>
    (
      await db
        .select()
        .from(runProgressNotifications)
        .where(
          and(eq(runProgressNotifications.runId, runId), isNull(runProgressNotifications.endedAt)),
        )
    ).length > 0;

  beforeAll(async () => {
    await database.create();
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    await database.drop();
  });

  it("sends the end after a crash between storing the run's status and sending its end", async () => {
    const run = await newRun();
    const first = worker();
    first.progress.start();
    first.events.emit("runStarted", run);
    await until(() => sent.length === 1);
    expect(await owed(run.id)).toBe(true);

    // The run finishes for real; the worker dies while it waits for the model logs, after the
    // completed status is committed and before `runFinished` (and so the end) goes.
    const writer = new RunEventWriter(db, pool, run.id, run.chatId, () => {});
    const [teammate] = await db.select().from(teammates).where(eq(teammates.id, run.teammateId));
    const [chat] = await db.select().from(chats).where(eq(chats.id, run.chatId));
    const session: FinalizeSession = {
      ctx: first.ctx,
      run,
      teammate: teammate!,
      chat: chat!,
      finish: null,
      items: new Map(),
      cancelled: false,
      writer,
      usage: {
        plan: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        api_key: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      },
      threadIds: new Set(["thread"]),
      services: { touchChat: async () => {}, settleModelLogs: () => new Promise(() => {}) },
      now: () => new Date().toISOString(),
      putItem: () => {},
      publishedPageId: () => null,
    };
    void complete(session, { status: "completed" });
    await until(async () => {
      const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
      return row?.status === "completed";
    });
    first.progress.stop();
    expect(ends(run.id)).toEqual([]);

    // The next worker starts, and the phone gets the end, once.
    const second = worker();
    second.progress.start();
    await until(() => ends(run.id).length === 1);
    await second.progress.idle();
    expect(await owed(run.id)).toBe(false);
    second.progress.stop();

    const third = worker();
    third.progress.start();
    await third.progress.idle();
    third.progress.stop();
    expect(ends(run.id)).toHaveLength(1);
  });

  it("sends the end of a run the restart interrupted, once recovery finishes it", async () => {
    const run = await newRun();
    const quiet = await newRun();
    const first = worker();
    first.progress.start();
    first.events.emit("runStarted", run);
    await until(() => sent.length === 1);
    // The worker dies while both runs are going; only the first had shown progress.
    first.progress.stop();

    const second = worker();
    second.progress.start();
    await second.progress.idle();
    expect(ends(run.id)).toEqual([]);
    // Recovery reads only the database and the approvals it expires.
    const none = {} as never;
    const approvals = { expireForRun: vi.fn(async () => {}) } as never;
    const executor = new RunExecutor(
      second.ctx,
      none,
      none,
      approvals,
      none,
      none,
      none,
      none,
      none,
      none,
      async () => {},
    );
    await executor.recover();
    await until(() => ends(run.id).length === 1);
    await second.progress.idle();
    second.progress.stop();
    expect(ends(quiet.id)).toEqual([]);
    expect(await owed(run.id)).toBe(false);
  });

  it("forgets an end no phone could use any more, and keeps the run's record fresh while it shows", async () => {
    const store = runProgressStore(db);
    const stale = await newRun();
    const recent = await newRun();
    const interrupted = await newRun();
    for (const run of [stale, recent, interrupted]) await store.shown(run.id);
    const shownAgo = (runId: string, ms: number) =>
      db
        .update(runProgressNotifications)
        .set({ shownAt: sql`now() - make_interval(secs => ${ms / 1000})` })
        .where(eq(runProgressNotifications.runId, runId));
    // Each phone's copy timed out a minute ago, or will in a few minutes.
    await shownAgo(stale.id, END_OWED_FOR_MS + 60_000);
    await shownAgo(interrupted.id, END_OWED_FOR_MS + 60_000);
    await shownAgo(recent.id, END_OWED_FOR_MS - 5 * 60_000);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, stale.id));
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, recent.id));

    // A start sends only the end a phone may still show, and forgets the other.
    const next = worker();
    next.progress.start();
    await next.progress.idle();
    expect(ends(stale.id)).toEqual([]);
    expect(ends(recent.id)).toHaveLength(1);
    expect(await owed(stale.id)).toBe(false);
    expect(await owed(recent.id)).toBe(false);
    // An interrupted run that recovery finishes long after it last showed gets no end.
    expect(await owed(interrupted.id)).toBe(false);
    next.events.emit("runFinished", { id: interrupted.id, trigger: "user" }, "interrupted", null);
    await next.progress.idle();
    next.progress.stop();
    expect(ends(interrupted.id)).toEqual([]);

    // Each update moves the record on, so a long wait never expires a run that still shows.
    const live = await newRun();
    await store.shown(live.id);
    await shownAgo(live.id, END_OWED_FOR_MS + 60_000);
    expect(await store.owed(live.id)).toBe(false);
    await store.shown(live.id);
    expect(await store.owed(live.id)).toBe(true);
  });

  it("never makes an end owed again with a save that lands after it", async () => {
    const store = runProgressStore(db);
    const run = await newRun();
    expect(await store.shown(run.id)).toBe(true);
    await store.ended(run.id);
    // The save of the run's last update was slow, and lands now.
    expect(await store.shown(run.id)).toBe(false);
    expect(await store.owed(run.id)).toBe(false);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, run.id));
    expect(await store.overdue()).not.toContain(run.id);
    // A run that ended before any save landed.
    const early = await newRun();
    await store.ended(early.id);
    expect(await store.shown(early.id)).toBe(false);
    expect(await owed(early.id)).toBe(false);
  });

  it("gives up a save that waits on a held row, instead of hanging", async () => {
    const store = runProgressStore(db, { lockTimeoutMs: 200, statementTimeoutMs: 1_000 });
    const run = await newRun();
    await store.shown(run.id);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from run_progress_notifications where run_id = $1 for update", [
        run.id,
      ]);
      const started = Date.now();
      await expect(store.shown(run.id)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(900);
      await expect(store.ended(run.id)).rejects.toThrow();
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    await store.ended(run.id);
    expect(await owed(run.id)).toBe(false);
  });

  it("forgets ended records once no save for them can still land", async () => {
    const store = runProgressStore(db);
    const run = await newRun();
    await store.shown(run.id);
    await store.ended(run.id);
    await store.overdue();
    expect(
      await db
        .select()
        .from(runProgressNotifications)
        .where(eq(runProgressNotifications.runId, run.id)),
    ).toHaveLength(1);
    await db
      .update(runProgressNotifications)
      .set({ endedAt: sql`now() - make_interval(secs => ${END_OWED_FOR_MS / 1000 + 60})` })
      .where(eq(runProgressNotifications.runId, run.id));
    await store.overdue();
    expect(
      await db
        .select()
        .from(runProgressNotifications)
        .where(eq(runProgressNotifications.runId, run.id)),
    ).toEqual([]);
  });
});
