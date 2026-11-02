import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bots,
  chatMembers,
  chats,
  createDb,
  createPool,
  messageDispatches,
  messages,
  runs,
} from "@open-bot/db";
import type { Context } from "../context";
import { SessionRegistry } from "../services/registry";
import { RunExecutor } from "./executor";
import type { RunSession } from "./session";

const url = process.env.MOBILE_API_TEST_DATABASE_URL;

/** Delivering messages exactly once, however often (and however concurrently) it's attempted. */
describe.skipIf(!url)("message dispatch with Postgres", () => {
  const pool = createPool(url ?? "postgres://unused");
  const db = createDb(pool);
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
  const unused = [{}, {}, {}, {}, {}, {}, {}];
  const executor = new RunExecutor(
    ...([ctx, sessions, ...unused] as unknown as ConstructorParameters<typeof RunExecutor>),
  );

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/openbot_mobile_api_test")
      throw new Error(
        "Use the disposable openbot_mobile_api_test database (pnpm test:mobile-api).",
      );
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url)),
    });
  });
  beforeEach(async () => {
    await pool.query("truncate bots, chats restart identity cascade");
    for (const session of sessions.all()) sessions.remove(session.run.id);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function bot(name: string) {
    const [row] = await db
      .insert(bots)
      .values({ name, slug: name.toLowerCase(), role: "assistant", color: "#4f46e5" })
      .returning();
    return row!;
  }

  async function directChat() {
    const teammate = await bot("Rex");
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: teammate.name, botId: teammate.id })
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
    expect(queued[0]).toMatchObject({ botId: teammate.id, trigger: "user", status: "queued" });
    const rows = await dispatchRows(sent.id);
    expect(rows).toEqual([
      expect.objectContaining({
        botId: teammate.id,
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
      { chatId: group!.id, botId: ada.id },
      { chatId: group!.id, botId: bo.id },
    ]);
    const sent = await message(group!.id, { mentions: [ada.id, bo.id] });
    await Promise.all([executor.dispatchMessage(sent.id), executor.dispatchMessage(sent.id)]);

    const queued = await runsFor(sent.id);
    expect(queued.map((run) => run.botId).sort()).toEqual([ada.id, bo.id].sort());
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
      .values({ messageId: sent.id, botId: teammate.id, kind: "steer", status: "sending" });

    await executor.recoverSteers();
    await executor.recoverSteers();

    expect(await runsFor(sent.id)).toHaveLength(1);
    const [row] = await db
      .select()
      .from(messageDispatches)
      .where(
        and(eq(messageDispatches.messageId, sent.id), eq(messageDispatches.botId, teammate.id)),
      );
    expect(row).toMatchObject({ kind: "run", status: "done" });
  });

  it("refuses a second run for the same message and teammate at the database", async () => {
    const { chat, teammate } = await directChat();
    const sent = await message(chat.id);
    const values = {
      chatId: chat.id,
      botId: teammate.id,
      trigger: "user" as const,
      prompt: sent.text,
      messageId: sent.id,
    };
    await db.insert(runs).values(values);
    await expect(db.insert(runs).values(values)).rejects.toThrow();
  });
});
