import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS, type ApiClient } from "@open-bot/api";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { ORPCError } from "@orpc/client";
import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = testDatabaseServer();
const OWNER = { id: "owner", name: "Alex Rivera", email: "alex@example.test" };

// The session check is Better Auth's; here every call is the owner's.
vi.mock("../auth", () => ({
  auth: { api: { getSession: async () => ({ user: OWNER }) } },
}));

const ids = {
  teammate: randomUUID(),
  chat: randomUUID(),
  run: randomUUID(),
  schedule: randomUUID(),
  trigger: randomUUID(),
  page: randomUUID(),
  version: randomUUID(),
  memory: "",
};

/** What the stand-in worker answers, by path; anything else is a 503, like a stopped worker. */
const WORKER: Record<string, unknown> = {
  "/internal/status": {
    computer: { online: true, health: null, lifecycle: null },
    codex: { connected: true, authSource: "host", account: null, login: null, error: null },
    egress: OFFLINE_EGRESS_STATUS,
  },
  "/internal/telegram": {
    connected: false,
    botUsername: null, // vocabulary: allow
    tokenHint: null,
    linked: false,
    linkedName: null,
    problem: null,
  },
  "/internal/push": { publicKey: "key", devices: [] },
  "/internal/codex/rate-limits": {
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    },
  },
};

/**
 * Every read of the API, through the real router (session check, output validation, error
 * mapping) and the real queries, on a disposable database with one of each thing in it, and a
 * stand-in worker. A view whose schema disagrees with what its query returns fails here.
 */
describe.skipIf(!url)("API reads, end to end", () => {
  const database = testDatabase(url);
  const workerPaths: string[] = [];
  let workerUp = true;
  const worker = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://worker").pathname;
    workerPaths.push(path);
    response.setHeader("content-type", "application/json");
    const listing =
      path === "/internal/files/list"
        ? {
            path: "/home/bot",
            entries: [
              { name: "shared", path: "/home/bot/shared", isDirectory: true, modifiedAt: null },
            ],
          }
        : undefined;
    const body = workerUp ? (listing ?? WORKER[path]) : undefined;
    if (body === undefined) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "The computer is offline." }));
      return;
    }
    response.end(JSON.stringify(body));
  });
  let api: ApiClient;

  beforeAll(async () => {
    await database.create();
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = database.url;
    process.env.WORKER_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    process.env.WORKER_SECRET = "router-test-secret";
    process.env.NEXT_PUBLIC_WORKER_WS_URL = "ws://worker.test";
    const { router } = await import("./router");
    api = createRouterClient(router, { context: { headers: new Headers() } }) as ApiClient;
    await seed();
  });

  afterAll(async () => {
    await new Promise((resolve) => worker.close(resolve));
    const { pool } = await import("../db");
    await pool.end();
    await database.drop();
  });

  async function seed() {
    const s = await import("@open-bot/db");
    const db = database.db;
    const now = new Date();
    await db.insert(s.settings).values({ id: 1, timezone: "Europe/Berlin" }).onConflictDoNothing();
    await db.insert(s.bots).values({
      id: ids.teammate,
      name: "Scout",
      slug: "scout",
      role: "Researcher",
      color: "#3b82f6",
    });
    await db
      .insert(s.chats)
      .values({ id: ids.chat, kind: "direct", title: "Scout", botId: ids.teammate });
    await db.insert(s.chatMembers).values({ chatId: ids.chat, botId: ids.teammate });
    await db.insert(s.runs).values({
      id: ids.run,
      chatId: ids.chat,
      botId: ids.teammate,
      trigger: "schedule",
      prompt: "Check the news",
      status: "completed",
      scheduleId: null,
      startedAt: now,
      completedAt: now,
    });
    await db.insert(s.runEvents).values({
      runId: ids.run,
      chatId: ids.chat,
      payload: { type: "status", status: "completed" },
    });
    await db.insert(s.schedules).values({
      id: ids.schedule,
      botId: ids.teammate,
      title: "Morning news",
      prompt: "Check the news",
      kind: "cron",
      cron: "0 8 * * *",
      timezone: "Europe/Berlin",
      createdBy: "user",
    });
    await db.update(s.runs).set({ scheduleId: ids.schedule });
    await db.insert(s.triggers).values({
      id: ids.trigger,
      botId: ids.teammate,
      kind: "watch",
      title: "Pricing page",
      prompt: "Tell me when it changes",
      url: "https://example.test/pricing",
      intervalMinutes: 60,
      createdBy: "user",
    });
    await db.insert(s.tasks).values({ title: "Book flights", createdBy: "user" });
    await db.insert(s.skills).values({
      name: "summarize",
      description: "Summarize a page",
      instructions: "Read it and summarize it.",
      createdBy: "user",
    });
    await db.insert(s.lessons).values({ botId: ids.teammate, text: "Keep it short." });
    await db
      .insert(s.notifications)
      .values({ kind: "run_finished", title: "Done", botId: ids.teammate });
    await db
      .insert(s.connections)
      .values({ label: "Docs", name: "docs", transport: "http", url: "https://mcp.test" });
    await db.insert(s.purchases).values({
      botId: ids.teammate,
      amountCents: 1200,
      merchant: "Books",
      description: "A book",
      status: "paid",
    });
    await db.insert(s.pages).values({ id: ids.page, title: "Trip plan", botId: ids.teammate });
    await db.insert(s.pageVersions).values({
      id: ids.version,
      pageId: ids.page,
      number: 1,
      title: "Trip plan",
      html: "<h1>Trip plan</h1>",
      size: 18,
      sha256: "0".repeat(64),
    });
    await db.update(s.pages).set({ currentVersionId: ids.version, versionCount: 1 });
    // A memory a teammate saved during the run, so its list names the teammate and the chat.
    const { memoryReady } = await import("../memory");
    const memory = await memoryReady();
    const saved = await memory.save(
      {
        botId: ids.teammate,
        kind: "preference",
        content: "Prefers window seats",
        key: null,
        pinned: false,
        expiresAt: null,
      },
      { kind: "bot", botId: ids.teammate, runId: ids.run, verified: true },
    );
    ids.memory = saved.id;
  }

  it("serves the shell's state with the worker's status", async () => {
    const state = await api.app.state();
    expect(state.user).toEqual({ name: OWNER.name, email: OWNER.email });
    expect(state.timezone).toBe("Europe/Berlin");
    expect(state.bots.map((bot) => bot.name)).toEqual(["Scout"]);
    expect(state.computer.workerOnline).toBe(true);
    expect(state.skills[0]).not.toHaveProperty("instructions");
    expect(state.unreadNotifications).toBe(1);
  });

  it("serves Home with the same badges as the shell", async () => {
    const [home, state] = await Promise.all([
      api.home.get({ awaySince: new Date(Date.now() - 3_600_000).toISOString() }),
      api.app.state(),
    ]);
    expect(home.unreadNotifications).toBe(state.unreadNotifications);
    expect(home.pendingApprovals).toBe(state.pendingApprovals);
    expect(home.activity.map((item) => item.runId)).toEqual([ids.run]);
    expect(home.briefing.map((item) => item.automationTitle)).toEqual(["Morning news"]);
  });

  it("serves every list and detail the web app reads", async () => {
    expect((await api.schedules.list()).map((s) => s.title)).toEqual(["Morning news"]);
    expect(await api.schedules.runs({ scheduleId: ids.schedule })).toHaveLength(1);
    expect((await api.triggers.list()).map((t) => t.title)).toEqual(["Pricing page"]);
    expect(await api.triggers.runs({ triggerId: ids.trigger })).toEqual([]);
    expect((await api.skills.list()).map((s) => s.name)).toEqual(["summarize"]);
    expect((await api.tasks.list()).map((t) => t.title)).toEqual(["Book flights"]);
    expect(await api.vault.list()).toEqual([]);
    expect(await api.profile.get()).toMatchObject({ aboutMe: "" });
    expect((await api.teammates.lessons({ botId: ids.teammate })).map((l) => l.text)).toEqual([
      "Keep it short.",
    ]);
    expect(await api.teammates.spending({ botId: ids.teammate })).toMatchObject({
      spentCents: 1200,
    });
    expect((await api.connections.list()).map((c) => c.label)).toEqual(["Docs"]);
    expect((await api.accounts.setup()).accounts).toEqual([]);
    expect(await api.email.status()).toMatchObject({ domain: null });
    expect(await api.settings.modelAccess()).toMatchObject({ keyHint: null });
    expect(await api.settings.usage()).toEqual([]);
    expect(await api.screens.frames()).toEqual({});
    expect((await api.pages.list()).map((p) => p.title)).toEqual(["Trip plan"]);
    expect((await api.pages.search({ query: "trip" })).map((p) => p.id)).toEqual([ids.page]);
    expect((await api.notifications.list()).map((n) => n.title)).toEqual(["Done"]);
    expect(await api.approvals.list()).toEqual([]);
    expect(await api.search.messages({ query: "news" })).toEqual([]);
    const memories = await api.memory.list({ botId: ids.teammate, query: "window" });
    expect(memories.map((m) => m.content)).toEqual(["Prefers window seats"]);
    expect(memories[0]!.source).toMatchObject({ botId: ids.teammate, chatId: ids.chat });
    expect(await api.memory.list({ botId: null, query: "nothing like it" })).toEqual([]);
    const history = await api.memory.history({ memoryId: ids.memory });
    expect(history.map((r) => r.source.chatId)).toEqual([ids.chat]);
    expect(await api.memory.forRun({ runId: ids.run })).toEqual([]);
  });

  it("passes the worker's reads through", async () => {
    expect(await api.telegram.status()).toMatchObject({ connected: false });
    expect(await api.push.status()).toEqual({ publicKey: "key", devices: [] });
    expect(await api.settings.rateLimits()).toMatchObject({
      rateLimits: { primary: { usedPercent: 12 } },
    });
    expect((await api.files.list({ path: "/home/bot" })).entries.map((e) => e.name)).toEqual([
      "shared",
    ]);
    expect(workerPaths).toContain("/internal/files/list");
  });

  it("says the computer is offline with a 503 the browser can tell apart", async () => {
    workerUp = false;
    try {
      const error = await api.telegram.status().catch((failed: unknown) => failed);
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).status).toBe(503);
      // Without the worker the shell still loads, and says it's offline.
      expect((await api.app.state()).computer.workerOnline).toBe(false);
    } finally {
      workerUp = true;
    }
  });

  it("says what's gone, and rejects ids that aren't", async () => {
    const missing = randomUUID();
    await expect(api.teammates.spending({ botId: missing })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.pages.get({ pageId: missing })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.teammates.lessons({ botId: "not-an-id" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("says what's wrong with refused input in the schema's words", async () => {
    await expect(api.chats.rename({ chatId: ids.chat, title: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Name the chat.",
      data: { issues: [expect.objectContaining({ path: ["title"] })] },
    });
  });
});
