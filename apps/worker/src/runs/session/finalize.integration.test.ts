import { EventEmitter } from "node:events";
import { bots, chats, runs } from "@open-bot/db"; // vocabulary: allow
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../../context";
import { RunEventWriter } from "../events";
import { complete, type FinalizeSession } from "./finalize";

const url = testDatabaseServer();

/** Finishing a run: its usage is in the model logs now, so nothing else records it. */
describe.skipIf(!url)("finishing a run", () => {
  const database = testDatabase(url);
  const { db, pool } = database;
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    computer: { releaseRun: vi.fn(async () => {}) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;

  beforeAll(async () => {
    await database.create();
  });
  afterAll(async () => {
    await database.drop();
  });

  it("writes no usage_entries, and waits for the run's model logs before it says it's done", async () => {
    const [teammate] = await db
      .insert(bots) // vocabulary: allow
      .values({ name: "Kit", slug: "kit", role: "Engineer", color: "#0ea5e9" })
      .returning();
    const [chat] = await db.insert(chats).values({ kind: "direct", title: "Kit" }).returning();
    const [run] = await db
      .insert(runs)
      .values({
        chatId: chat!.id,
        botId: teammate!.id, // vocabulary: allow
        trigger: "user",
        prompt: "Say hi.",
        status: "running",
      })
      .returning();
    const writer = new RunEventWriter(db, pool, run!.id, chat!.id, () => {});
    const order: string[] = [];
    const write = writer.write.bind(writer);
    vi.spyOn(writer, "write").mockImplementation((payload) => {
      order.push(payload.type);
      write(payload);
    });
    const session: FinalizeSession = {
      ctx,
      run: run!,
      bot: teammate!, // vocabulary: allow
      chat: chat!,
      finish: null,
      items: new Map(),
      cancelled: false,
      writer,
      usage: {
        plan: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 10 },
        api_key: { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 20 },
      },
      threadIds: new Set(["thread-plan", "thread-key"]),
      services: {
        touchChat: async () => {},
        settleModelLogs: vi.fn(async (threadIds: readonly string[]) => {
          order.push(`settle:${[...threadIds].join(",")}`);
        }),
      },
      now: () => new Date().toISOString(),
      putItem: () => {},
      publishedPageId: () => null,
    };

    await complete(session, { status: "completed" });

    const { rows } = await pool.query("select count(*)::int as count from usage_entries");
    expect(rows[0].count).toBe(0);
    // Open chats read the footer when the status arrives, so the logs are saved first.
    expect(order).toEqual(["settle:thread-plan,thread-key", "usage", "status"]);
  });
});
