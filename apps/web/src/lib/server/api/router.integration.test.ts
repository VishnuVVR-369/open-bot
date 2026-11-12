import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS, type ApiClient } from "@open-bot/api";
import { BUNDLE_FORMAT, BUNDLE_VERSION, DAILY_CHECK_IN } from "@open-bot/domain";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { ORPCError } from "@orpc/client";
import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = testDatabaseServer();
const OWNER = { id: "owner", name: "Alex Rivera", email: "alex@example.test" };

// The session check is Better Auth's; here every call is the owner's.
vi.mock("../auth", () => ({
  auth: { api: { getSession: async () => ({ user: OWNER, session: { id: "session-1" } }) } },
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
  "/internal/email": {
    domain: null,
    inboundPath: "/api/inbound/email/token",
    tokenHint: null,
    lastReceivedAt: null,
    addresses: [],
  },
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
  /** A row's teammate, under the column's legacy name. */
  const owned = <T extends string | null>(teammateId: T) => ({ botId: teammateId });
  const workerPaths: string[] = [];
  /** What the web app sent the worker, by path, newest last. */
  const workerBodies: { path: string; body: unknown }[] = [];
  /** Answers a test gives to a worker write, by path. */
  const answers = new Map<string, { status: number; body: unknown }>();
  let workerUp = true;
  const worker = http.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://worker").pathname;
    workerPaths.push(path);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    workerBodies.push({ path, body: raw ? JSON.parse(raw) : undefined });
    response.setHeader("content-type", "application/json");
    const answer = answers.get(path);
    if (answer) {
      response.statusCode = answer.status;
      response.end(JSON.stringify(answer.body));
      return;
    }
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
      .values({ id: ids.chat, kind: "direct", title: "Scout", ...owned(ids.teammate) });
    await db.insert(s.chatMembers).values({ chatId: ids.chat, ...owned(ids.teammate) });
    await db.insert(s.runs).values({
      id: ids.run,
      chatId: ids.chat,
      ...owned(ids.teammate),
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
      ...owned(ids.teammate),
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
      ...owned(ids.teammate),
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
    await db.insert(s.lessons).values({ ...owned(ids.teammate), text: "Keep it short." });
    await db
      .insert(s.notifications)
      .values({ kind: "run_finished", title: "Done", ...owned(ids.teammate) });
    await db
      .insert(s.connections)
      .values({ label: "Docs", name: "docs", transport: "http", url: "https://mcp.test" });
    await db.insert(s.purchases).values({
      ...owned(ids.teammate),
      amountCents: 1200,
      merchant: "Books",
      description: "A book",
      status: "paid",
    });
    await db.insert(s.pages).values({ id: ids.page, title: "Trip plan", ...owned(ids.teammate) });
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
        ...owned(ids.teammate),
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

  it("links a teammate to its main chat, or to its latest direct chat while none is marked", async () => {
    const s = await import("@open-bot/db");
    const db = database.db;
    const linked = async () => (await api.app.state()).bots[0]!.directChatId; // vocabulary: allow
    // As a worker from before main chats leaves it: direct chats, none of them marked.
    expect(await linked()).toBe(ids.chat);
    const [newer] = await db
      .insert(s.chats)
      .values({
        kind: "direct",
        title: "Scout",
        lastActivityAt: new Date(Date.now() + 60_000),
        ...owned(ids.teammate),
      })
      .returning();
    try {
      expect(await linked()).toBe(newer!.id);
      await db.update(s.chats).set({ main: true }).where(eq(s.chats.id, ids.chat));
      expect(await linked()).toBe(ids.chat);
    } finally {
      await db.update(s.chats).set({ main: false }).where(eq(s.chats.id, ids.chat));
      await db.delete(s.chats).where(eq(s.chats.id, newer!.id));
    }
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
    expect(await api.email.status()).toMatchObject({ inboundPath: "/api/inbound/email/token" });
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

  /* The writes the web app does itself, and how worker failures reach the caller. */

  const PROFILE = {
    name: "Iris",
    role: "Writer",
    instructions: "",
    color: "#10b981",
    emoji: "",
    autonomy: "risky" as const,
  };

  /** A teammate file with this name. */
  const teammateFile = (name: string, version = BUNDLE_VERSION) =>
    JSON.stringify({ format: BUNDLE_FORMAT, version, teammate: { name, role: "Helper" } });

  it("passes teammate changes to the worker, which owns them, after checking a file", async () => {
    await expect(api.teammates.import({ file: "{" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This isn't an open-bot teammate file.",
    });
    await expect(
      api.teammates.import({ file: teammateFile("Atlas", BUNDLE_VERSION + 1) }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("from a newer open-bot"),
    });
    expect(workerPaths.some((path) => path === "/internal/teammates/import")).toBe(false);

    const teammateId = ids.teammate;
    const proposalId = randomUUID();
    const scheduleId = randomUUID();
    const ok = { status: 200, body: { ok: true } };
    const created = { teammateId: randomUUID(), chatId: randomUUID() };
    const calls: [string, () => Promise<unknown>, unknown][] = [
      [
        "/internal/teammates/import",
        () => api.teammates.import({ file: teammateFile("Atlas") }),
        { bundle: { teammate: { name: "Atlas", role: "Helper" }, routines: [] } },
      ],
      [
        `/internal/teammates/${teammateId}/duplicate`,
        () => api.teammates.duplicate({ teammateId, name: "Scout 2", copyMemory: true }),
        { name: "Scout 2", copyMemory: true },
      ],
      [`/internal/teammates/${teammateId}/lead`, () => api.teammates.setLead({ teammateId }), {}],
      [
        `/internal/teammates/${teammateId}/archive`,
        () => api.teammates.archive({ teammateId }),
        {},
      ],
      [
        `/internal/teammates/${teammateId}/budget`,
        () => api.teammates.setBudget({ teammateId, budget: 120.5, autoApprove: 20 }),
        { budget: 120.5, autoApprove: 20 },
      ],
      [`/internal/proposals/${proposalId}/accept`, () => api.proposals.accept({ proposalId }), {}],
      [
        `/internal/proposals/${proposalId}/dismiss`,
        () => api.proposals.dismiss({ proposalId }),
        {},
      ],
      [`/internal/schedules/${scheduleId}/delete`, () => api.schedules.remove({ scheduleId }), {}],
    ];
    answers.set("/internal/teammates/import", {
      status: 200,
      body: { ...created, name: "Atlas", paused: 0 },
    });
    answers.set(`/internal/teammates/${teammateId}/duplicate`, {
      status: 200,
      body: { ...created, memoryCopied: true },
    });
    for (const [path] of calls.slice(2)) answers.set(path, ok);
    try {
      for (const [path, call, body] of calls) {
        await call();
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      // The worker's refusals keep its words and become the contract's errors.
      answers.set(`/internal/teammates/${teammateId}/lead`, {
        status: 404,
        body: { error: "That teammate no longer exists.", code: "NOT_FOUND" },
      });
      await expect(api.teammates.setLead({ teammateId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That teammate no longer exists.",
      });
      answers.set(`/internal/proposals/${proposalId}/dismiss`, {
        status: 409,
        body: { error: "That suggestion was already handled.", code: "CONFLICT" },
      });
      await expect(api.proposals.dismiss({ proposalId })).rejects.toMatchObject({
        code: "STATE_CONFLICT",
        message: "That suggestion was already handled.",
      });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });

  it("passes chat and run changes to the worker, and keeps a reused message id a CONFLICT", async () => {
    const chatId = ids.chat;
    const runId = randomUUID();
    const teammateId = ids.teammate;
    const message = {
      id: randomUUID(),
      role: "user",
      text: "Hi",
      attachments: [],
      mentions: [],
      steeredRunId: null,
      redoOfRunId: null,
      createdAt: new Date().toISOString(),
    };
    const send = { clientId: randomUUID(), chatId, text: "Hi", attachments: [], mentions: [] };
    const feedback = { runId, text: "Shorter.", remember: true, redo: { clientId: randomUUID() } };
    const ok = { status: 200, body: { ok: true } };
    const created = { status: 200, body: { chatId } };
    const calls: [string, () => Promise<unknown>, unknown, { status: number; body: unknown }][] = [
      [
        "/internal/chats/direct",
        () => api.chats.newDirect({ botId: teammateId }),
        { teammateId },
        created,
      ],
      [
        "/internal/chats/group",
        () => api.chats.createGroup({ title: "Launch", botIds: [teammateId, runId] }),
        { title: "Launch", teammateIds: [teammateId, runId] },
        created,
      ],
      [
        `/internal/chats/${chatId}/rename`,
        () => api.chats.rename({ chatId, title: "R" }),
        { title: "R" },
        ok,
      ],
      [`/internal/chats/${chatId}/archive`, () => api.chats.archive({ chatId }), {}, ok],
      [`/internal/chats/${chatId}/main`, () => api.chats.makeMain({ chatId }), {}, ok],
      [`/internal/chats/${chatId}/read`, () => api.chats.markRead({ chatId }), {}, ok],
      [
        `/internal/chats/${chatId}/messages`,
        () => api.chats.send(send),
        { clientId: send.clientId, text: "Hi", attachments: [], mentions: [] },
        { status: 200, body: message },
      ],
      [`/internal/runs/${runId}/stop`, () => api.runs.cancel({ runId }), {}, ok],
      [
        `/internal/runs/${runId}/rate`,
        () => api.runs.rate({ runId, rating: "up" }),
        { rating: "up" },
        ok,
      ],
      [
        `/internal/runs/${runId}/feedback`,
        () => api.runs.feedback(feedback),
        { text: feedback.text, remember: true, redo: feedback.redo },
        ok,
      ],
    ];
    for (const [path, , , answer] of calls) answers.set(path, answer);
    try {
      for (const [path, call, body] of calls) {
        await call();
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      expect(await api.chats.send(send)).toEqual(message);
      // A reused id is the contract's CONFLICT, which the composer tells apart from a stale edit.
      const reused = {
        status: 409,
        body: { error: "That message id was already used for another message.", code: "CONFLICT" },
      };
      answers.set(`/internal/chats/${chatId}/messages`, reused);
      answers.set(`/internal/runs/${runId}/feedback`, reused);
      for (const call of [() => api.chats.send(send), () => api.runs.feedback(feedback)])
        await expect(call()).rejects.toMatchObject({
          code: "CONFLICT",
          message: "That message id was already used for another message.",
        });
      answers.set(`/internal/runs/${runId}/stop`, {
        status: 404,
        body: { error: "That reply is gone.", code: "NOT_FOUND" },
      });
      await expect(api.runs.cancel({ runId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That reply is gone.",
      });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });

  it("turns a daily check-in on in the owner's time zone, and resumes it rather than adding one", async () => {
    const s = await import("@open-bot/db");
    const checkIn = randomUUID();
    answers.set("/internal/schedules", { status: 200, body: { id: checkIn } });
    answers.set(`/internal/schedules/${checkIn}/enabled`, { status: 200, body: { ok: true } });
    try {
      await api.schedules.setCheckIn({ teammateId: ids.teammate, on: true });
      expect(workerBodies.findLast((b) => b.path === "/internal/schedules")?.body).toMatchObject({
        ...owned(ids.teammate),
        title: DAILY_CHECK_IN.title,
        timezone: "Europe/Berlin",
        quiet: true,
      });
      // What the worker would have saved.
      await database.db.insert(s.schedules).values({
        id: checkIn,
        ...owned(ids.teammate),
        title: DAILY_CHECK_IN.title,
        prompt: DAILY_CHECK_IN.prompt,
        kind: "cron",
        cron: DAILY_CHECK_IN.cron,
        timezone: "Europe/Berlin",
        quiet: true,
        createdBy: "user",
      });
      const created = workerBodies.filter((b) => b.path === "/internal/schedules").length;
      await api.schedules.setCheckIn({ teammateId: ids.teammate, on: false });
      await api.schedules.setCheckIn({ teammateId: ids.teammate, on: true });
      expect(
        workerBodies
          .filter((b) => b.path === `/internal/schedules/${checkIn}/enabled`)
          .map((b) => b.body),
      ).toEqual([{ enabled: false }, { enabled: true }]);
      expect(workerBodies.filter((b) => b.path === "/internal/schedules")).toHaveLength(created);
    } finally {
      const { eq } = await import("drizzle-orm");
      await database.db.delete(s.schedules).where(eq(s.schedules.id, checkIn));
      answers.clear();
    }
  });

  it("sends a webhook a test request only while it exists", async () => {
    const s = await import("@open-bot/db");
    // A page watch has no URL to call.
    await expect(api.triggers.test({ triggerId: ids.trigger })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "That webhook no longer exists.",
    });
    const [hook] = await database.db
      .insert(s.triggers)
      .values({
        ...owned(ids.teammate),
        kind: "webhook",
        title: "Deploys",
        prompt: "Tell me about failed deploys",
        token: "hook-token",
        createdBy: "user",
      })
      .returning({ id: s.triggers.id });
    const runId = randomUUID();
    answers.set("/internal/hooks/hook-token", { status: 200, body: { runId } });
    try {
      expect(await api.triggers.test({ triggerId: hook!.id })).toEqual({ runId });
      expect(
        workerBodies.findLast((b) => b.path === "/internal/hooks/hook-token")?.body,
      ).toMatchObject({ method: "POST", contentType: "application/json" });
    } finally {
      answers.clear();
    }
  });

  it("says a teammate changed since it was loaded as a state conflict, in the worker's words", async () => {
    const message = "Scout changed since you opened this. Reload to see the latest.";
    answers.set(`/internal/bots/${ids.teammate}`, { status: 409, body: { error: message } });
    try {
      await expect(
        api.teammates.update({ teammateId: ids.teammate, profile: PROFILE, revision: "old" }),
      ).rejects.toMatchObject({ code: "STATE_CONFLICT", status: 409, message });
    } finally {
      answers.clear();
    }
  });

  it("passes vault, page and notification changes to the worker, which owns them", async () => {
    const itemId = randomUUID();
    const pageId = randomUUID();
    const login = {
      id: null,
      kind: "login" as const,
      name: "GitHub",
      domain: "github.com",
      teammateIds: [ids.teammate],
      secret: { username: "alex", password: "hunter22" },
    };
    const ok = { status: 200, body: { ok: true } };
    const calls: [string, () => Promise<unknown>, unknown, { status: number; body: unknown }][] = [
      [
        "/internal/vault",
        () => api.vault.save(login),
        login,
        { status: 200, body: { id: itemId } },
      ],
      [`/internal/vault/${itemId}/delete`, () => api.vault.remove({ itemId }), {}, ok],
      [
        `/internal/pages/${pageId}/pin`,
        () => api.pages.pin({ pageId, pinned: true }),
        { pinned: true },
        ok,
      ],
      [`/internal/pages/${pageId}/delete`, () => api.pages.remove({ pageId }), {}, ok],
      [
        "/internal/notifications/read",
        () => api.notifications.markRead({ through: itemId }),
        { through: itemId },
        ok,
      ],
    ];
    for (const [path, , , answer] of calls) answers.set(path, answer);
    try {
      for (const [path, call, body, answer] of calls) {
        expect(await call()).toEqual(answer.body);
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      answers.set(`/internal/pages/${pageId}/pin`, {
        status: 404,
        body: { error: "That page was deleted.", code: "NOT_FOUND" },
      });
      await expect(api.pages.pin({ pageId, pinned: false })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That page was deleted.",
      });
      // The contract refuses an item nobody may use before it reaches the worker.
      await expect(api.vault.save({ ...login, teammateIds: [] })).rejects.toMatchObject({
        message: "Pick at least one teammate, or everyone.",
      });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });

  it("passes connection changes to the worker, which owns them, and its refusals through", async () => {
    const connectionId = randomUUID();
    const server = {
      id: null,
      label: "Linear",
      transport: "http" as const,
      url: "https://mcp.linear.test/mcp",
      command: "",
      args: "",
      secrets: "Authorization: Bearer abc",
      teammateIds: null,
    };
    const change = {
      connectionId,
      capabilities: ["read"],
      teammateIds: [ids.teammate],
      askBeforeActing: true,
    };
    const calls: [string, () => Promise<unknown>, unknown, { status: number; body: unknown }][] = [
      [
        "/internal/connections",
        () => api.connections.save(server),
        server,
        { status: 200, body: { id: connectionId } },
      ],
      [
        `/internal/connections/${connectionId}/enabled`,
        () => api.connections.setEnabled({ connectionId, enabled: false }),
        { enabled: false },
        { status: 200, body: { ok: true } },
      ],
      [
        `/internal/connections/${connectionId}/delete`,
        () => api.connections.remove({ connectionId }),
        {},
        { status: 200, body: { warning: "Google couldn't be reached." } },
      ],
      [
        `/internal/connections/${connectionId}/account`,
        () => api.accounts.update(change),
        { capabilities: ["read"], teammateIds: [ids.teammate], askBeforeActing: true },
        { status: 200, body: { needsConsent: true } },
      ],
    ];
    for (const [path, , , answer] of calls) answers.set(path, answer);
    try {
      for (const [path, call, body, answer] of calls) {
        expect(await call()).toEqual(answer.body);
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      answers.set("/internal/connections", {
        status: 400,
        body: { error: "Give the command the computer runs.", code: "BAD_REQUEST" },
      });
      answers.set(`/internal/connections/${connectionId}/enabled`, {
        status: 404,
        body: { error: "That connection is gone.", code: "NOT_FOUND" },
      });
      await expect(
        api.connections.save({ ...server, transport: "stdio", command: "" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Give the command the computer runs.",
      });
      await expect(
        api.connections.setEnabled({ connectionId, enabled: true }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "That connection is gone." });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });

  it("tests a connection from the computer, through the worker", async () => {
    const [docs] = await api.connections.list();
    const found = {
      ok: true,
      status: "connected",
      tools: [{ name: "search", description: "" }],
      error: null,
    };
    answers.set(`/internal/connections/${docs!.id}/test`, { status: 200, body: found });
    try {
      expect(await api.connections.test({ connectionId: docs!.id })).toEqual(found);
      const offline = "The computer is offline.";
      answers.set(`/internal/connections/${docs!.id}/test`, {
        status: 503,
        body: { error: offline },
      });
      await expect(api.connections.test({ connectionId: docs!.id })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        message: offline,
      });
    } finally {
      answers.clear();
    }
  });

  it("starts a Google sign-in for this session once your client is saved", async () => {
    const connect = {
      kind: "gmail" as const,
      capabilities: ["read"],
      teammateIds: null,
      accountId: null,
    };
    await expect(api.accounts.connect(connect)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Add your Google OAuth client first (Set up Google).",
    });
    await expect(
      api.accounts.saveClient({ provider: "google", clientId: "nope", clientSecret: "x" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Google OAuth client ID"),
    });
    await api.accounts.saveClient({
      provider: "google",
      clientId: "1234-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret-value",
    });
    const { url: signIn } = await api.accounts.connect(connect);
    expect(new URL(signIn).searchParams.get("client_id")).toBe(
      "1234-abc.apps.googleusercontent.com",
    );
    const s = await import("@open-bot/db");
    const states = await database.db
      .select({ sessionId: s.oauthStates.sessionId })
      .from(s.oauthStates);
    expect(states).toEqual([{ sessionId: "session-1" }]);
  });

  it("passes settings and email changes to the worker, which owns them, and its refusals through", async () => {
    const ok = { status: 200, body: { ok: true } };
    const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";
    const email = { domain: "team.example.test", token: "0123456789abcdef-0123456789" };
    const calls: [string, () => Promise<unknown>, unknown][] = [
      [
        "/internal/settings/timezone",
        () => api.settings.setTimezone({ timezone: "Asia/Tokyo" }),
        { timezone: "Asia/Tokyo" },
      ],
      [
        "/internal/settings/api-key",
        () => api.settings.saveApiKey({ apiKey: ` ${apiKey} ` }),
        { apiKey },
      ],
      ["/internal/settings/api-key/delete", () => api.settings.removeApiKey(), undefined],
      [
        "/internal/settings/monthly-cap",
        () => api.settings.setMonthlyCap({ dollars: 25.5 }),
        { dollars: 25.5 },
      ],
      ["/internal/email", () => api.email.save(email), email],
      ["/internal/email/token/delete", () => api.email.removeToken(), undefined],
    ];
    const sync = `/internal/bots/${ids.teammate}/sync`; // vocabulary: allow
    for (const [path] of calls) answers.set(path, ok);
    answers.set(sync, ok);
    try {
      for (const [path, call, body] of calls) {
        const before = workerBodies.length;
        expect(await call()).toEqual({ ok: true });
        expect(workerBodies.slice(before).find((b) => b.path === path)).toEqual({ path, body });
      }
      // Saved email settings reach each teammate's instructions.
      expect(workerPaths).toContain(sync);

      answers.set("/internal/settings/timezone", {
        status: 400,
        body: { error: "Unknown timezone.", code: "BAD_REQUEST" },
      });
      await expect(api.settings.setTimezone({ timezone: "Mars/Olympus" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Unknown timezone.",
      });
      // The contract refuses input before it reaches the worker.
      const before = workerBodies.length;
      await expect(api.settings.saveApiKey({ apiKey: "pk-123" })).rejects.toMatchObject({
        message: "That doesn't look like an OpenAI API key. It starts with sk-.",
      });
      await expect(api.settings.setMonthlyCap({ dollars: Number.NaN })).rejects.toMatchObject({
        message: "Give the cap in dollars, like 50.",
      });
      expect(workerBodies.length).toBe(before);
    } finally {
      for (const [path] of calls) answers.delete(path);
      answers.delete(sync);
    }
  });

  it("saves, edits, restores and forgets a memory, refusing an edit to a stale revision", async () => {
    const saved = await api.memory.create({ ...owned(null), content: "Lives in Berlin" });
    expect(saved).toMatchObject({ saveOutcome: "created", revision: 1 });
    expect(await api.memory.create({ ...owned(null), content: "lives in  berlin" })).toMatchObject({
      id: saved.id,
      saveOutcome: "unchanged",
    });
    const edited = await api.memory.update({
      id: saved.id,
      expectedRevision: 1,
      ...owned(null),
      content: "Lives in Hamburg",
    });
    expect(edited.revision).toBe(2);
    await expect(
      api.memory.update({
        id: saved.id,
        expectedRevision: 1,
        ...owned(null),
        content: "Lives in Bonn",
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", status: 409 });
    const restored = await api.memory.restore({ id: saved.id, expectedRevision: 2, revision: 1 });
    expect(restored).toMatchObject({ content: "Lives in Berlin", revision: 3 });
    await api.memory.forget({ id: saved.id, expectedRevision: 3 });
    expect(await api.memory.list({ ...owned(null), query: "Berlin" })).toEqual([]);
  });

  it("confirms a teammate's suggested memory", async () => {
    const { memoryReady } = await import("../memory");
    const suggested = await (
      await memoryReady()
    ).save(
      {
        ...owned(ids.teammate),
        kind: "fact",
        content: "Has a dog named Rex",
        key: null,
        pinned: false,
        expiresAt: null,
      },
      { kind: "bot", botId: ids.teammate, runId: ids.run, verified: false }, // vocabulary: allow
    );
    expect(suggested.state).toBe("candidate");
    const confirmed = await api.memory.confirm({
      id: suggested.id,
      expectedRevision: suggested.revision,
    });
    expect(confirmed.state).toBe("active");
  });
});
