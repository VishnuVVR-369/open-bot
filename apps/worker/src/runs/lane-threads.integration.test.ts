import { randomUUID } from "node:crypto";
import type { CodexClient } from "@open-bot/agent"; // vocabulary: allow
import {
  teammates,
  teammateThreads as conversationThreads,
  chatLaneThreads,
  chats,
  runs,
} from "@open-bot/db"; // vocabulary: allow
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing"; // vocabulary: allow
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { ensureThread, type ThreadSession } from "./session/threads";

const url = testDatabaseServer();
describe.skipIf(!url)("lane threads with Postgres", () => {
  const database = testDatabase(url);
  const { db, pool } = database;
  beforeAll(() => database.create());
  afterAll(() => database.drop());

  it("keeps conversations and automation threads separate while preserving existing thread behavior", async () => {
    const [teammate] = await db
      .insert(teammates)
      .values({
        name: "Scout",
        slug: "scout",
        role: "research",
        color: "#4f46e5",
      })
      .returning();
    const [chat] = await db
      .insert(chats)
      .values({
        kind: "direct",
        title: "Scout",
        teammateId: teammate!.id,
        main: true, // vocabulary: allow
      })
      .returning();
    const loaded = new Set<string>();
    const ctx = {
      db,
      env: {},
      log: { warn: vi.fn() },
      codex: {
        isLoaded: (id: string) => loaded.has(id),
        markLoaded: (id: string) => loaded.add(id),
      },
    } as unknown as Context;
    const request = vi.fn(async () => ({ thread: { id: randomUUID() } }));
    const client = { request } as unknown as CodexClient;
    const base = {
      ctx,
      bot: teammate!, // vocabulary: allow
      authMode: "plan",
      apiKey: null, // vocabulary: allow
      agentsFile: "# Scout",
      memoryGeneration: "1:0:0",
      workspace: "/tmp/scout",
      services: { connections: async () => ({ key: "", config: {} }), tools: { specs: () => [] } },
    } satisfies Omit<ThreadSession, "run">;
    const session = async (lane: ThreadSession["run"]["lane"]) => {
      const [run] = await db
        .insert(runs)
        .values({
          chatId: chat!.id,
          teammateId: teammate!.id,
          trigger: "user",
          prompt: "Go",
          lane, // vocabulary: allow
        })
        .returning();
      return { ...base, run: run! };
    };
    const conversation = await session("chat");
    const schedule = await session(`schedule:${randomUUID()}`);
    const inbox = await session("inbox");
    const conversationId = await ensureThread(conversation, client);
    const scheduleId = await ensureThread(schedule, client);
    const inboxId = await ensureThread(inbox, client);
    expect(new Set([conversationId, scheduleId, inboxId]).size).toBe(3);
    expect(await ensureThread(conversation, client)).toBe(conversationId);
    expect(await ensureThread(schedule, client)).toBe(scheduleId);
    expect(await db.select().from(conversationThreads)).toHaveLength(1);
    expect(await db.select().from(chatLaneThreads)).toHaveLength(2);

    loaded.clear();
    expect(await ensureThread(schedule, client)).toBe(scheduleId);
    expect(request).toHaveBeenLastCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: scheduleId }),
    );

    const forked = await ensureThread(
      { ...schedule, agentsFile: "# Scout\nNew instructions" },
      client,
    );
    expect(forked).not.toBe(scheduleId);
    expect(request).toHaveBeenLastCalledWith(
      "thread/fork",
      expect.objectContaining({ threadId: scheduleId }),
    );
    expect(await ensureThread(conversation, client)).toBe(conversationId);
    const fresh = await ensureThread({ ...schedule, memoryGeneration: "2:0:0" }, client);
    expect(fresh).not.toBe(forked);
    expect(request).toHaveBeenLastCalledWith("thread/start", expect.anything());

    // The old worker's exact conflict key remains valid after the additive migration.
    await pool.query(
      "insert into bot_threads (chat_id, bot_id, codex_thread_id) values ($1, $2, $3) on conflict (chat_id, bot_id) do update set codex_thread_id = excluded.codex_thread_id", // vocabulary: allow
      [chat!.id, teammate!.id, "older-worker"],
    );
    const [legacy] = await db
      .select()
      .from(conversationThreads)
      .where(eq(conversationThreads.chatId, chat!.id));
    expect(legacy!.codexThreadId).toBe("older-worker");
    expect(await db.select().from(chatLaneThreads)).toHaveLength(2);
  });
});
