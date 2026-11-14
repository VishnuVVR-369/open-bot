import { EventEmitter } from "node:events";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { teammates, chatMembers, chats, messageDispatches, messages, runs } from "@open-bot/db";
import type { Context } from "../context";
import { MemoryService } from "@open-bot/memory";
import { SessionRegistry } from "./registry";
import { RunExecutor } from "./executor";
import type { RunSession } from "./session";

const url = testDatabaseServer();

/** Delivering messages exactly once, however often (and however concurrently) it's attempted. */
describe.skipIf(!url)("message dispatch with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    // No run starts executing: these tests only look at what's queued.
    env: { MAX_CONCURRENT_RUNS: 0 },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const sessions = new SessionRegistry();
  // Dispatching only uses the database and the running sessions.
  const memory = new MemoryService(db);
  const unused = [{}, {}, {}, {}, {}, {}, { store: memory }];
  const executor = new RunExecutor(
    ...([ctx, sessions, ...unused] as unknown as ConstructorParameters<typeof RunExecutor>),
  );

  beforeAll(async () => {
    await database.create();
  });
  beforeEach(async () => {
    await pool.query("truncate bots, chats restart identity cascade");
    for (const session of sessions.all()) sessions.remove(session.run.id);
  });
  afterAll(async () => {
    await database.drop();
  });

  async function bot(name: string) {
    const [row] = await db
      .insert(teammates)
      .values({ name, slug: name.toLowerCase(), role: "assistant", color: "#4f46e5" })
      .returning();
    return row!;
  }

  async function directChat() {
    const teammate = await bot("Rex");
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: teammate.name, teammateId: teammate.id })
      .returning();
    return { teammate, chat: chat! };
  }

  async function message(chatId: string, values: Partial<typeof messages.$inferInsert> = {}) {
    const [row] = await db
      .insert(messages)
      .values({ chatId, role: "user", text: "Book the flight", ...values })
      .returning();
    return row!;
  }

  async function runsFor(messageId: string) {
    return db.select().from(runs).where(eq(runs.messageId, messageId));
  }

  async function dispatchRows(messageId: string) {
    return db.select().from(messageDispatches).where(eq(messageDispatches.messageId, messageId));
  }

  /** A teammate's running turn that the next message can join. */
  function runningSession(chatId: string, botId: string, steers: boolean) {
    const runId = crypto.randomUUID();
    const steer = vi.fn(async () => steers);
    sessions.add({
      run: { id: runId },
      chat: { id: chatId },
      bot: { id: botId },
      steer,
    } as unknown as RunSession);
    return { runId, steer };
  }

  it("starts one run however many times a message is dispatched, even at once", async () => {
    const { chat, teammate } = await directChat();
    const sent = await message(chat.id);
    await Promise.all([
      executor.dispatchMessage(sent.id),
      executor.dispatchMessage(sent.id),
      executor.dispatchMessage(sent.id),
    ]);
    await executor.dispatchMessage(sent.id);

    const queued = await runsFor(sent.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ teammateId: teammate.id, trigger: "user", status: "queued" });
    const rows = await dispatchRows(sent.id);
    expect(rows).toEqual([
      expect.objectContaining({
        teammateId: teammate.id,
        kind: "run",
        status: "done",
        runId: queued[0]!.id,
      }),
    ]);
    const [after] = await db.select().from(messages).where(eq(messages.id, sent.id));
    expect(after!.dispatchStatus).toBe("dispatched");
  });

  it("delivers a message that was saved but never dispatched, like after a crash", async () => {
    const { chat } = await directChat();
    const sent = await message(chat.id, { createdAt: new Date(Date.now() - 60_000) });
    const fresh = await message(chat.id, { text: "Just sent" });

    await executor.reconcileDispatches();

    expect(await runsFor(sent.id)).toHaveLength(1);
    // Still inside its grace period: the web app's own dispatch call is probably on its way.
    expect(await runsFor(fresh.id)).toHaveLength(0);
    await executor.reconcileDispatches(0);
    expect(await runsFor(fresh.id)).toHaveLength(1);
    expect(await runsFor(sent.id)).toHaveLength(1);
  });

  it("gives each mentioned teammate in a group one run", async () => {
    const [ada, bo] = [await bot("Ada"), await bot("Bo")];
    const [group] = await db.insert(chats).values({ kind: "group", title: "Team" }).returning();
    await db.insert(chatMembers).values([
      { chatId: group!.id, teammateId: ada.id },
      { chatId: group!.id, teammateId: bo.id },
    ]);
    const sent = await message(group!.id, { mentions: [ada.id, bo.id] });
    await Promise.all([executor.dispatchMessage(sent.id), executor.dispatchMessage(sent.id)]);

    const queued = await runsFor(sent.id);
    expect(queued.map((run) => run.teammateId).sort()).toEqual([ada.id, bo.id].sort());
  });

  it("joins a running turn once, without starting a run", async () => {
    const { chat, teammate } = await directChat();
    const { runId, steer } = runningSession(chat.id, teammate.id, true);
    const sent = await message(chat.id);
    await executor.dispatchMessage(sent.id);
    await executor.dispatchMessage(sent.id);

    expect(steer).toHaveBeenCalledTimes(1);
    expect(await runsFor(sent.id)).toHaveLength(0);
    expect(await dispatchRows(sent.id)).toEqual([
      expect.objectContaining({ kind: "steer", status: "done", runId }),
    ]);
    const [after] = await db.select().from(messages).where(eq(messages.id, sent.id));
    expect(after!.steeredRunId).toBe(runId);
  });

  it("starts a run when the running turn refuses the message", async () => {
    const { chat, teammate } = await directChat();
    runningSession(chat.id, teammate.id, false);
    const sent = await message(chat.id);
    await executor.dispatchMessage(sent.id);

    expect(await runsFor(sent.id)).toHaveLength(1);
    expect(await dispatchRows(sent.id)).toEqual([
      expect.objectContaining({ kind: "run", status: "done" }),
    ]);
  });

  it("turns a steer the restart interrupted into a run, once", async () => {
    const { chat, teammate } = await directChat();
    const sent = await message(chat.id, { dispatchStatus: "dispatched" });
    await db
      .insert(messageDispatches)
      .values({ messageId: sent.id, teammateId: teammate.id, kind: "steer", status: "sending" });

    await executor.recoverSteers();
    await executor.recoverSteers();

    expect(await runsFor(sent.id)).toHaveLength(1);
    const [row] = await db
      .select()
      .from(messageDispatches)
      .where(
        and(
          eq(messageDispatches.messageId, sent.id),
          eq(messageDispatches.teammateId, teammate.id),
        ),
      );
    expect(row).toMatchObject({ kind: "run", status: "done" });
  });

  it("refuses a second run for the same message and teammate at the database", async () => {
    const { chat, teammate } = await directChat();
    const sent = await message(chat.id);
    const values = {
      chatId: chat.id,
      teammateId: teammate.id,
      trigger: "user" as const,
      prompt: sent.text,
      messageId: sent.id,
    };
    await db.insert(runs).values(values);
    await expect(db.insert(runs).values(values)).rejects.toThrow();
  });

  it("recovers a redo's lesson before dispatch, without duplicating or restoring it on retries", async () => {
    const { chat, teammate } = await directChat();
    const [source] = await db
      .insert(runs)
      .values({
        chatId: chat.id,
        teammateId: teammate.id,
        trigger: "user",
        prompt: "Original request",
        status: "completed",
      })
      .returning();
    const sent = await message(chat.id, {
      text: "Include sources",
      redoOfRunId: source!.id,
      feedbackRequest: { text: "Include sources", remember: true },
      createdAt: new Date(0),
    });
    // The app accepted the redo, but its first attempt to save the lesson was interrupted.
    const save = vi.spyOn(memory, "save").mockRejectedValueOnce(new Error("interrupted"));
    await expect(executor.dispatchMessage(sent.id)).rejects.toThrow("interrupted");
    expect(await runsFor(sent.id)).toHaveLength(0);
    expect(
      (await db.select().from(messages).where(eq(messages.id, sent.id)))[0]!.dispatchStatus,
    ).toBe("pending");
    save.mockRestore();

    await executor.reconcileDispatches(0);
    await Promise.all([executor.dispatchMessage(sent.id), executor.dispatchMessage(sent.id)]);
    expect(await runsFor(sent.id)).toHaveLength(1);
    const lessons = await memory.list({ teammateId: teammate.id }, { kind: "user" });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ kind: "lesson", content: "Include sources", revision: 1 });

    await memory.forget(
      { id: lessons[0]!.id, expectedRevision: lessons[0]!.revision },
      { kind: "user" },
    );
    await executor.dispatchMessage(sent.id);
    expect(await memory.list({ teammateId: teammate.id }, { kind: "user" })).toHaveLength(0);
  });
});
