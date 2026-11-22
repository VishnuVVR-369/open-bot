import { EventEmitter } from "node:events";
import { chats, runProgressNotifications, runs, teammates } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, WorkerEvents } from "../context";
import type { Run } from "../core/db-types";
import {
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
      chatTitle: null,
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
        .where(eq(runProgressNotifications.runId, runId))
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
});
