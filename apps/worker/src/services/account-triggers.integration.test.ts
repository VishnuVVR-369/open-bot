import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AccountStore } from "@open-bot/accounts";
import { bots, chats, connections, runs, triggerFirings, triggers } from "@open-bot/db";
import { ACCOUNT_TRIGGER_NOTE, GOOGLE_SCOPES } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import type { Context } from "../context";
import { AccountAccess } from "../accounts/access";
import { AccountTriggers } from "./account-triggers";
import { ACCOUNT_TRIGGER_RUNS_PER_HOUR, TriggerService } from "./triggers";

const url = testDatabaseServer();

/** The check start() runs every 30 seconds, called directly to await it. */
const tick = (service: AccountTriggers) => (service as unknown as { tick(): Promise<void> }).tick();

const base64Url = (text: string) => Buffer.from(text).toString("base64url");

interface FakeMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  internalDate: number;
  labelIds: string[];
}

interface FakeEvent {
  id: string;
  summary: string;
  status?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string; self?: boolean; responseStatus?: string }[];
}

/** A small Gmail and Calendar, as much of them as triggers use. */
class FakeGoogle {
  historyId = 1000;
  messages: FakeMessage[] = [];
  history: {
    id: string;
    messagesAdded: { message: { id: string; threadId: string; labelIds: string[] } }[];
  }[] = [];
  events: FakeEvent[] = [];
  /** Gmail has forgotten history this old, as after a long outage. */
  historyGone = false;
  calls: string[] = [];

  reset(): void {
    this.historyId = 1000;
    this.messages = [];
    this.history = [];
    this.events = [];
    this.historyGone = false;
    this.calls = [];
  }

  /** New mail, as Gmail records it: a message and a history entry after it. */
  deliver(message: Partial<FakeMessage> & { id: string }): void {
    const full: FakeMessage = {
      threadId: `t-${message.id}`,
      from: "Priya <priya@example.com>",
      subject: `Subject ${message.id}`,
      text: `Body of ${message.id}`,
      internalDate: Date.now(),
      labelIds: ["INBOX", "UNREAD"],
      ...message,
    };
    this.messages.push(full);
    this.historyId += 1;
    this.history.push({
      id: String(this.historyId),
      messagesAdded: [
        { message: { id: full.id, threadId: full.threadId, labelIds: full.labelIds } },
      ],
    });
  }

  handle(path: string, query: URLSearchParams): { status: number; body: unknown } {
    this.calls.push(path);
    const gmail = "/gmail/v1/users/me";
    if (path === `${gmail}/profile`)
      return {
        status: 200,
        body: { emailAddress: "me@example.com", historyId: String(this.historyId) },
      };
    if (path === `${gmail}/history`) {
      if (this.historyGone)
        return {
          status: 404,
          body: { error: { code: 404, message: "Requested entity was not found." } },
        };
      const start = BigInt(query.get("startHistoryId") ?? "0");
      const history = this.history.filter((record) => BigInt(record.id) > start);
      return { status: 200, body: { history, historyId: String(this.historyId) } };
    }
    if (path === `${gmail}/messages`) {
      const q = query.get("q") ?? "";
      const from = /\(from:(\S+)\)/.exec(q)?.[1];
      const days = Number(/newer_than:(\d+)d/.exec(q)?.[1] ?? 365);
      const messages = this.messages
        .filter((message) => !message.labelIds.includes("SENT"))
        .filter((message) => !from || message.from.includes(from))
        .filter((message) => message.internalDate > Date.now() - days * 86_400_000)
        .sort((a, b) => b.internalDate - a.internalDate)
        .map(({ id, threadId }) => ({ id, threadId }));
      return { status: 200, body: messages.length ? { messages } : {} };
    }
    const one = new RegExp(`^${gmail}/messages/([^/]+)$`).exec(path);
    if (one) {
      const message = this.messages.find((entry) => entry.id === decodeURIComponent(one[1]!));
      if (!message) return { status: 404, body: { error: { code: 404, message: "Not found" } } };
      return {
        status: 200,
        body: {
          id: message.id,
          threadId: message.threadId,
          labelIds: message.labelIds,
          internalDate: String(message.internalDate),
          snippet: message.text.slice(0, 50),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: message.from },
              { name: "To", value: "me@example.com" },
              { name: "Subject", value: message.subject },
              { name: "Date", value: new Date(message.internalDate).toUTCString() },
            ],
            body: { data: base64Url(message.text), size: message.text.length },
          },
        },
      };
    }
    if (path === "/calendar/v3/calendars/primary/events") {
      const min = Date.parse(query.get("timeMin")!);
      const max = Date.parse(query.get("timeMax")!);
      const items = this.events.filter((event) => {
        const start = Date.parse(event.start.dateTime ?? event.start.date!);
        const end = Date.parse(event.end.dateTime ?? event.end.date!);
        return end > min && start < max;
      });
      return { status: 200, body: { items } };
    }
    return { status: 404, body: { error: { code: 404, message: `No route ${path}` } } };
  }
}

describe.skipIf(!url)("Gmail and Calendar triggers with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  const key = randomBytes(32).toString("base64");
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    env: { APP_URL: "https://openbot.test", ENCRYPTION_KEY: key },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const google = new FakeGoogle();
  let server: Server;

  /** A worker's trigger services. Two of these stand for two workers during a deploy. */
  const worker = () => new AccountTriggers(ctx, new AccountAccess(ctx), new TriggerService(ctx));

  let fixture: { botId: string; gmailId: string; calendarId: string };

  beforeAll(async () => {
    await database.create();
    server = createServer((request, response) => {
      const parsed = new URL(request.url ?? "/", "http://stand-in");
      const { status, body } = google.handle(parsed.pathname, parsed.searchParams);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GOOGLE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await pool.query(
      "truncate bots, chats, connections, accounts, oauth_clients restart identity cascade",
    );
    google.reset();
    const [bot] = await db
      .insert(bots)
      .values({ name: "Otto", slug: "otto", role: "assistant", color: "#4f46e5" })
      .returning();
    const store = new AccountStore(db, key);
    const client = await store.clients.makeCurrent({
      provider: "google",
      source: "owner",
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "secret-1234567",
      hint: null,
    });
    const { account } = await store.saveGrant({
      provider: "google",
      externalId: "sub-1",
      oauthClientId: client.id,
      display: "me@example.com",
      tokens: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3600_000,
        tokenType: "Bearer",
        scope: `openid email ${GOOGLE_SCOPES.gmailRead} ${GOOGLE_SCOPES.calendarRead}`,
        extra: {},
      },
    });
    const [gmail, calendar] = await db
      .insert(connections)
      .values([
        {
          label: "Gmail",
          name: "gmail",
          kind: "gmail",
          capabilities: ["read"],
          accountId: account.id,
        },
        {
          label: "Google Calendar",
          name: "calendar",
          kind: "google_calendar",
          capabilities: ["read"],
          accountId: account.id,
        },
      ])
      .returning();
    fixture = { botId: bot!.id, gmailId: gmail!.id, calendarId: calendar!.id };
  });

  afterAll(async () => {
    delete process.env.GOOGLE_BASE_URL;
    await new Promise((resolve) => server?.close(resolve));
    await database.drop();
  });

  async function trigger(values: Partial<typeof triggers.$inferInsert> = {}) {
    const [row] = await db
      .insert(triggers)
      .values({
        botId: fixture.botId,
        kind: "gmail",
        title: "New mail",
        prompt: "Summarize it for me.",
        connectionId: fixture.gmailId,
        nextCheckAt: new Date(Date.now() - 1000),
        createdBy: "user",
        ...values,
      })
      .returning();
    return row!;
  }

  const reload = async (id: string) =>
    (await db.select().from(triggers).where(eq(triggers.id, id)))[0]!;

  /** Due again, as if its interval had passed. */
  const due = (id: string) =>
    db
      .update(triggers)
      .set({ nextCheckAt: new Date(Date.now() - 1000) })
      .where(eq(triggers.id, id));

  const triggerRuns = (id: string) => db.select().from(runs).where(eq(runs.triggerId, id));

  it("starts from the mailbox as it is, then wakes once for each new message", async () => {
    google.deliver({ id: "before" });
    const service = worker();
    const row = await trigger();
    await tick(service);
    const start = (await reload(row.id)).cursor;
    expect(start).toBe(String(google.historyId));
    expect(await triggerRuns(row.id)).toHaveLength(0);

    google.deliver({ id: "m1", subject: "Quarterly numbers", text: "See the attached numbers." });
    await due(row.id);
    await tick(service);
    const [run] = await triggerRuns(row.id);
    expect(run).toBeDefined();
    expect(run!.readOutsideData).toBe(true);
    expect(run!.trigger).toBe("gmail");
    // It works in the teammate's main chat, in a lane of its own.
    expect(run!.lane).toBe(`trigger:${row.id}`);
    const [chat] = await db.select().from(chats).where(eq(chats.id, run!.chatId));
    expect(chat).toMatchObject({ kind: "direct", main: true });
    expect(run!.prompt).toContain("Summarize it for me.");
    expect(run!.prompt).toContain(ACCOUNT_TRIGGER_NOTE);
    expect(run!.prompt).toMatch(
      /<outside_data[^>]*>[\s\S]*Quarterly numbers[\s\S]*<\/outside_data>/,
    );
    expect(run!.prompt).not.toContain("Body of before");
    const after = await reload(row.id);
    expect(after.lastFiredAt).not.toBeNull();
    expect(after.lastError).toBeNull();
    const [firing] = await db
      .select()
      .from(triggerFirings)
      .where(eq(triggerFirings.triggerId, row.id));
    expect(firing).toMatchObject({ key: "mail:m1", runId: run!.id });

    // The same history again, as after a worker stopped before saving its cursor.
    await db.update(triggers).set({ cursor: start }).where(eq(triggers.id, row.id));
    await due(row.id);
    await tick(service);
    expect(await triggerRuns(row.id)).toHaveLength(1);
  });

  it("wakes a teammate once when two workers and Check now look at the same mail", async () => {
    const row = await trigger({ cursor: String(google.historyId) });
    google.deliver({ id: "m1" });
    const first = worker();
    const second = worker();
    const results = await Promise.all([
      tick(first),
      tick(second),
      first.checkNow(row.id),
      second.checkNow(row.id),
    ]);
    expect(results).toHaveLength(4);
    expect(await triggerRuns(row.id)).toHaveLength(1);
  });

  it("serves every trigger on a mailbox from one history request, each with its own search", async () => {
    const cursor = String(google.historyId);
    const boss = await trigger({ title: "From the boss", query: "from:boss@example.com", cursor });
    const all = await trigger({ title: "Everything", cursor });
    google.deliver({ id: "m1", from: "Boss <boss@example.com>" });
    google.deliver({ id: "m2", from: "Newsletter <news@example.com>" });
    await tick(worker());
    expect(google.calls.filter((call) => call.endsWith("/history"))).toHaveLength(1);
    const [bossRun] = await triggerRuns(boss.id);
    expect(bossRun!.prompt).toContain("message m1");
    expect(bossRun!.prompt).not.toContain("message m2");
    const [allRun] = await triggerRuns(all.id);
    expect(allRun!.prompt).toMatch(/2 new emails/);
  });

  it("skips what you sent, and mail older than the trigger when Gmail lost the history", async () => {
    const row = await trigger({ cursor: "1" });
    google.historyGone = true;
    google.deliver({ id: "old", internalDate: Date.now() - 3 * 3600_000 });
    google.deliver({ id: "mine", labelIds: ["SENT"] });
    google.deliver({ id: "new" });
    await tick(worker());
    const found = await triggerRuns(row.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.prompt).toContain("message new");
    expect(found[0]!.prompt).not.toContain("message old");
    expect(found[0]!.prompt).not.toContain("message mine");
    expect((await reload(row.id)).cursor).toBe(String(google.historyId));
  });

  it("stops at the hourly limit and says so", async () => {
    const row = await trigger({ cursor: String(google.historyId) });
    const [chat] = await db
      .insert(chats)
      .values({ kind: "scheduled", title: "Scheduled", botId: fixture.botId })
      .returning();
    await db.insert(runs).values(
      Array.from({ length: ACCOUNT_TRIGGER_RUNS_PER_HOUR }, () => ({
        chatId: chat!.id,
        botId: fixture.botId,
        trigger: "gmail" as const,
        triggerId: row.id,
        prompt: "Earlier",
        status: "completed" as const,
      })),
    );
    google.deliver({ id: "m1" });
    await tick(worker());
    expect(await triggerRuns(row.id)).toHaveLength(ACCOUNT_TRIGGER_RUNS_PER_HOUR);
    expect((await reload(row.id)).lastError).toMatch(/Skipped: it already started 30 runs/);
  });

  it("doesn't call Gmail for a connection that's off, and says why", async () => {
    const row = await trigger({ cursor: String(google.historyId) });
    await db.update(connections).set({ enabled: false }).where(eq(connections.id, fixture.gmailId));
    google.deliver({ id: "m1" });
    await tick(worker());
    expect(google.calls).toHaveLength(0);
    expect(await triggerRuns(row.id)).toHaveLength(0);
    expect((await reload(row.id)).lastError).toMatch(/turned off/);
  });

  it("wakes once before each event, again when it moves, and never for ones it isn't about", async () => {
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    const guest = { email: "priya@example.com" };
    const me = { email: "me@example.com", self: true, responseStatus: "accepted" };
    google.events = [
      {
        id: "standup",
        summary: "Standup",
        start: { dateTime: at(30) },
        end: { dateTime: at(45) },
        attendees: [me, guest],
      },
      {
        id: "focus",
        summary: "Focus time",
        start: { dateTime: at(31) },
        end: { dateTime: at(90) },
      },
      {
        id: "declined",
        summary: "Declined",
        start: { dateTime: at(30) },
        end: { dateTime: at(60) },
        attendees: [{ ...me, responseStatus: "declined" }, guest],
      },
      {
        id: "gone",
        summary: "Cancelled",
        status: "cancelled",
        start: { dateTime: at(30) },
        end: { dateTime: at(60) },
        attendees: [me, guest],
      },
      {
        id: "later",
        summary: "Later",
        start: { dateTime: at(180) },
        end: { dateTime: at(200) },
        attendees: [me, guest],
      },
    ];
    const row = await trigger({
      kind: "calendar",
      title: "Before meetings",
      prompt: "Prepare a brief.",
      connectionId: fixture.calendarId,
      query: "guests",
      leadMinutes: 30,
    });
    const service = worker();
    await tick(service);
    let found = await triggerRuns(row.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.prompt).toContain("“Standup” starts in 30 minutes");
    expect(found[0]!.readOutsideData).toBe(true);

    await due(row.id);
    await tick(service);
    expect(await triggerRuns(row.id)).toHaveLength(1);

    google.events[0]!.start.dateTime = at(25);
    google.events[0]!.end.dateTime = at(40);
    await due(row.id);
    await tick(service);
    found = await triggerRuns(row.id);
    expect(found).toHaveLength(2);
  });
});
