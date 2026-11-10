import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS, type ApiClient } from "@open-bot/api";
import { BUNDLE_FORMAT, BUNDLE_VERSION, DAILY_CHECK_IN } from "@open-bot/domain";
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
  /** A row's teammate, under the column's legacy name. */
  const owned = (teammateId: string) => ({ botId: teammateId });
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

  /* The writes the web app does itself, and how worker failures reach the caller. */

  const PROFILE = {
    name: "Iris",
    role: "Writer",
    instructions: "",
    color: "#10b981",
    emoji: "",
    autonomy: "risky" as const,
  };

  type TeammateRow = { id: string; name: string; slug: string; archived: boolean; lead: boolean };

  /** Every teammate as stored, and whether it leads. */
  async function teammateRows(): Promise<TeammateRow[]> {
    const { sql } = await import("drizzle-orm");
    const { rows } = await database.db.execute<TeammateRow>(
      sql`select id, name, slug, archived_at is not null as archived, is_primary as lead from bots`, // vocabulary: allow
    );
    return rows;
  }

  async function teammate(id: string) {
    return (await teammateRows()).find((row) => row.id === id)!;
  }

  async function leads() {
    return (await teammateRows()).filter((row) => row.lead).map((row) => row.name);
  }

  /** A teammate file with this name, and these routines. */
  const teammateFile = (name: string, routines: object[] = [], version = BUNDLE_VERSION) =>
    JSON.stringify({
      format: BUNDLE_FORMAT,
      version,
      teammate: { name, role: "Helper" },
      routines,
    });

  it("makes one teammate the lead, and leaves the lead alone when asked for one that's gone", async () => {
    const iris = await api.teammates.import({ file: teammateFile("Iris") });
    const gone = await api.teammates.import({ file: teammateFile("Gone") });
    await api.teammates.archive({ teammateId: gone.teammateId });
    await api.teammates.setLead({ teammateId: iris.teammateId });
    expect(await leads()).toEqual(["Iris"]);
    await api.teammates.setLead({ teammateId: ids.teammate });
    expect(await leads()).toEqual(["Scout"]);
    for (const teammateId of [gone.teammateId, randomUUID()])
      await expect(api.teammates.setLead({ teammateId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That teammate no longer exists.",
      });
    expect(await leads()).toEqual(["Scout"]);
  });

  it("keeps exactly one lead when two are chosen at once", async () => {
    const { teammateId: juno } = await api.teammates.import({ file: teammateFile("Juno") });
    for (let round = 0; round < 10; round += 1) {
      await Promise.all([
        api.teammates.setLead({ teammateId: juno }),
        api.teammates.setLead({ teammateId: ids.teammate }),
      ]);
      expect(await leads()).toHaveLength(1);
    }
    await api.teammates.setLead({ teammateId: ids.teammate });
  });

  it("duplicates a teammate with its memory, and its routines paused", async () => {
    const copy = await api.teammates.duplicate({
      teammateId: ids.teammate,
      name: "Scout 2",
      copyMemory: true,
    });
    expect(copy.memoryCopied).toBe(true);
    expect(await teammate(copy.teammateId)).toMatchObject({
      name: "Scout 2",
      slug: "scout-2",
      lead: false,
    });
    const s = await import("@open-bot/db");
    const { eq } = await import("drizzle-orm");
    const [chat] = await database.db.select().from(s.chats).where(eq(s.chats.id, copy.chatId));
    expect(chat).toMatchObject({ kind: "direct", botId: copy.teammateId });
    const routines = await database.db
      .select()
      .from(s.schedules)
      .where(eq(s.schedules.botId, copy.teammateId));
    expect(routines.map((r) => [r.title, r.enabled])).toEqual([["Morning news", false]]);
    const memories = await api.memory.list({ botId: copy.teammateId, query: "window" });
    expect(memories.map((m) => m.content)).toEqual(["Prefers window seats"]);
    // The computer was away; its workspace is written before its first run instead.
    expect(workerPaths.some((path) => path.endsWith(`/${copy.teammateId}/sync`))).toBe(true);
    await expect(
      api.teammates.duplicate({ teammateId: randomUUID(), name: "Nobody", copyMemory: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives copies made at once different slugs", async () => {
    const copies = await Promise.all(
      [1, 2, 3].map(() =>
        api.teammates.duplicate({ teammateId: ids.teammate, name: "Echo", copyMemory: false }),
      ),
    );
    const slugs = await Promise.all(
      copies.map(async (copy) => (await teammate(copy.teammateId)).slug),
    );
    expect(slugs.sort()).toEqual(["echo", "echo-2", "echo-3"]);
  });

  it("imports a teammate file, and says what's wrong with one it can't read", async () => {
    await expect(api.teammates.import({ file: "{" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This isn't an open-bot teammate file.",
    });
    const weekly = [{ title: "Weekly plan", prompt: "Plan the week", cron: "0 9 * * 1" }];
    await expect(
      api.teammates.import({ file: teammateFile("Atlas", weekly, BUNDLE_VERSION + 1) }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("from a newer open-bot"),
    });
    const atlas = await api.teammates.import({ file: teammateFile("Atlas", weekly) });
    expect(atlas).toMatchObject({ name: "Atlas", paused: 1 });
    // Only the first teammate leads.
    expect(await teammate(atlas.teammateId)).toMatchObject({ slug: "atlas", lead: false });
  });

  it("archives a teammate: its chats, automations and work stop together", async () => {
    const s = await import("@open-bot/db");
    const { eq } = await import("drizzle-orm");
    const { teammateId, chatId } = await api.teammates.import({ file: teammateFile("Retiring") });
    await api.teammates.setLead({ teammateId });
    const [run] = await database.db
      .insert(s.runs)
      .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "queued" })
      .returning({ id: s.runs.id });
    await database.db.insert(s.schedules).values({
      ...owned(teammateId),
      title: "Daily digest",
      prompt: "Summarize the day",
      kind: "cron",
      cron: "0 18 * * *",
      timezone: "Europe/Berlin",
      createdBy: "user",
    });
    await database.db.insert(s.triggers).values({
      ...owned(teammateId),
      kind: "watch",
      title: "Status page",
      prompt: "Tell me",
      url: "https://example.test/status",
      intervalMinutes: 60,
      createdBy: "user",
    });
    await api.teammates.archive({ teammateId });
    expect(await teammate(teammateId)).toMatchObject({ archived: true, lead: false });
    const [chat] = await database.db.select().from(s.chats).where(eq(s.chats.id, chatId));
    expect(chat!.archivedAt).not.toBeNull();
    const routines = await database.db
      .select()
      .from(s.schedules)
      .where(eq(s.schedules.botId, teammateId));
    expect(routines.map((r) => r.enabled)).toEqual([false]);
    const watches = await database.db
      .select()
      .from(s.triggers)
      .where(eq(s.triggers.botId, teammateId));
    expect(watches.map((t) => t.enabled)).toEqual([false]);
    const [stopped] = await database.db.select().from(s.runs).where(eq(s.runs.id, run!.id));
    expect(stopped!.cancelRequestedAt).not.toBeNull();
    expect(workerPaths).toContain(`/internal/screens/${teammateId}/forget`);
    await api.teammates.setLead({ teammateId: ids.teammate });
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
      await api.schedules.remove({ scheduleId: checkIn });
      const { eq } = await import("drizzle-orm");
      expect(
        await database.db.select().from(s.schedules).where(eq(s.schedules.id, checkIn)),
      ).toEqual([]);
    } finally {
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
});
