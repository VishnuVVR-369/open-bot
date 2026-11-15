import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bots, messages, notifications, runs, telegram, telegramMessages } from "@open-bot/db"; // vocabulary: allow
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { MemoryService } from "@open-bot/memory";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../context";
import { RunExecutor } from "../../runs/executor";
import { SessionRegistry } from "../../runs/registry";
import type { ApprovalService } from "../approvals";
import type { TgUpdate } from "./api";
import { handle } from "./inbound";
import { listen, type UpdateRetry } from "./polling";
import { TelegramService } from "./service";

const url = testDatabaseServer();

const TOKEN = "123456789:AAE-test-token-for-open-bot-polling-000";
const OWNER = { id: 424242, first_name: "Erin" };

/**
 * A stand-in for Telegram's getUpdates, as Telegram keeps it: an update stays until a
 * getUpdates asks for an offset past it, which acknowledges it, and is gone for good after that.
 */
class TelegramStandIn {
  private server: Server | null = null;
  private pending: TgUpdate[] = [];
  private nextUpdate = 1;
  private nextMessage = 1000;
  private waiting: (() => void)[] = [];
  /** The highest update id a getUpdates acknowledged. */
  acknowledged = 0;
  /** How often each update was handed out. */
  readonly deliveries = new Map<number, number>();
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.serve(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const wake of this.waiting.splice(0)) wake();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset(): void {
    this.pending = [];
    this.acknowledged = this.nextUpdate - 1;
    this.deliveries.clear();
    this.sent.length = 0;
  }

  private push(update: Omit<TgUpdate, "update_id">): number {
    const id = this.nextUpdate++;
    this.pending.push({ update_id: id, ...update });
    for (const wake of this.waiting.splice(0)) wake();
    return id;
  }

  /** The owner writes on Telegram. Returns the update's id. */
  say(text: string): number {
    return this.push({
      message: {
        message_id: this.nextMessage++,
        chat: { id: OWNER.id, type: "private" },
        from: OWNER,
        text,
      },
    });
  }

  /** The owner presses a button on a message sent to them. Returns the update's id. */
  press(data: string): number {
    return this.push({
      callback_query: {
        id: `cb${this.nextUpdate}`,
        from: OWNER,
        data,
        message: { message_id: 1, chat: { id: OWNER.id } },
      },
    });
  }

  texts(): string[] {
    return this.sent.filter((m) => m.method === "sendMessage").map((m) => String(m.params.text));
  }

  private async serve(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const params = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const method = /^\/bot[^/]+\/(\w+)$/.exec(request.url ?? "")?.[1]; // vocabulary: allow
    if (method === "getUpdates") {
      const offset = Number(params.offset ?? 0);
      if (offset > 0) {
        this.pending = this.pending.filter((update) => update.update_id >= offset);
        this.acknowledged = Math.max(this.acknowledged, offset - 1);
      }
      if (this.pending.length === 0)
        await new Promise<void>((resolve) => {
          this.waiting.push(resolve);
          setTimeout(resolve, 200);
        });
      for (const update of this.pending)
        this.deliveries.set(update.update_id, (this.deliveries.get(update.update_id) ?? 0) + 1);
      return reply(200, { ok: true, result: this.pending });
    }
    this.sent.push({ method: method ?? "", params });
    return reply(200, {
      ok: true,
      result: method === "sendMessage" ? { message_id: this.nextMessage++ } : true,
    });
  }
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Long polling Telegram: a message is acknowledged only once it was handled. */
describe.skipIf(!url)("Telegram polling with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  const standIn = new TelegramStandIn();
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    // No run starts executing: these tests only look at what's queued.
    env: { MAX_CONCURRENT_RUNS: 0, APP_URL: "https://openbot.test", TELEGRAM_API_BASE_URL: "" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const sessions = new SessionRegistry();
  const unused = [{}, {}, {}, {}, {}, {}, { store: new MemoryService(db) }];
  const executor = new RunExecutor(
    ...([ctx, sessions, ...unused] as unknown as ConstructorParameters<typeof RunExecutor>),
  );
  const decide = vi.fn<ApprovalService["decide"]>();
  const services: TelegramService[] = [];

  /** A worker's Telegram service, polling. */
  function polling(retry: UpdateRetry): TelegramService {
    const service = new TelegramService(
      ctx,
      executor,
      { decide } as unknown as ApprovalService,
      { save: vi.fn() },
      retry,
    );
    services.push(service);
    service.token = TOKEN;
    listen(service);
    return service;
  }

  const saved = (text: string) => db.select().from(messages).where(eq(messages.text, text));
  const offset = async () =>
    (await db.select().from(telegram).where(eq(telegram.id, 1)))[0]!.updateOffset;

  beforeAll(async () => {
    await database.create();
    (ctx.env as { TELEGRAM_API_BASE_URL: string }).TELEGRAM_API_BASE_URL = await standIn.start();
  });
  beforeEach(async () => {
    await pool.query(
      "truncate bots, chats, telegram, telegram_messages, notifications restart identity cascade", // vocabulary: allow
    );
    standIn.reset();
    decide.mockReset().mockResolvedValue(true);
    await db.insert(telegram).values({
      id: 1,
      botUsername: "openbot_test_bot", // vocabulary: allow
      chatId: String(OWNER.id),
      updateOffset: standIn.acknowledged + 1,
    });
    await db
      .insert(bots) // vocabulary: allow
      .values({ name: "Otto", slug: "otto", role: "assistant", color: "#4f46e5" });
  });
  afterEach(async () => {
    for (const service of services.splice(0)) service.stop();
    // Put back what a test renamed, if it failed before doing so itself.
    await pool.query("alter table if exists bots_gone rename to bots"); // vocabulary: allow
    await pool.query("alter table if exists dispatches_gone rename to message_dispatches");
  });
  afterAll(async () => {
    await standIn.stop();
    await database.drop();
  });

  const patient: UpdateRetry = { attempts: 1000, ms: 60 * 60_000, delayMs: () => 20 };

  it("keeps a message the database can't route yet, then handles it once", async () => {
    // As in a deploy whose migration renamed the teammates' table under the running worker.
    await pool.query("alter table bots rename to bots_gone"); // vocabulary: allow
    const service = polling(patient);
    const update = standIn.say("Check the build");
    await until(() => (standIn.deliveries.get(update) ?? 0) >= 3, "the update was retried");
    expect(standIn.acknowledged).toBeLessThan(update);
    expect(await offset()).toBeLessThanOrEqual(update);
    expect(await saved("Check the build")).toHaveLength(0);
    expect(service.problem).toMatch(/couldn't be handled yet.*relation "bots" does not exist/); // vocabulary: allow

    await pool.query("alter table bots_gone rename to bots"); // vocabulary: allow
    await until(() => standIn.acknowledged >= update, "the update was acknowledged");
    const [message] = await saved("Check the build");
    expect(message).toMatchObject({ via: "telegram" });
    expect(await saved("Check the build")).toHaveLength(1);
    expect(await db.select().from(runs).where(eq(runs.messageId, message!.id))).toHaveLength(1);
    expect(await db.select().from(telegramMessages)).toHaveLength(1);
    expect(await offset()).toBe(update + 1);
    expect(service.problem).toBeNull();
  });

  it("finishes a message it saved but couldn't hand on, without saving it twice", async () => {
    await pool.query("alter table message_dispatches rename to dispatches_gone");
    polling(patient);
    const update = standIn.say("Draft the summary");
    await until(() => (standIn.deliveries.get(update) ?? 0) >= 3, "the update was retried");
    expect(standIn.acknowledged).toBeLessThan(update);
    expect(await saved("Draft the summary")).toHaveLength(1);

    await pool.query("alter table dispatches_gone rename to message_dispatches");
    await until(() => standIn.acknowledged >= update, "the update was acknowledged");
    const found = await saved("Draft the summary");
    expect(found).toHaveLength(1);
    expect(await db.select().from(runs).where(eq(runs.messageId, found[0]!.id))).toHaveLength(1);
  });

  it("saves and dispatches a message once, however often its update is handled", async () => {
    const service = new TelegramService(ctx, executor, { decide } as unknown as ApprovalService, {
      save: vi.fn(),
    });
    service.token = TOKEN;
    const update: TgUpdate = {
      update_id: 1,
      message: {
        message_id: 77,
        chat: { id: OWNER.id, type: "private" },
        from: OWNER,
        text: "Book the table",
      },
    };
    await Promise.all([handle(service, update), handle(service, update)]);
    await handle(service, update);
    const found = await saved("Book the table");
    expect(found).toHaveLength(1);
    expect(await db.select().from(runs).where(eq(runs.messageId, found[0]!.id))).toHaveLength(1);
  });

  it("skips an update that keeps failing, tells you, and goes on to the next", async () => {
    const poison = "0b8a8c7e-5f43-4c2e-9a39-2a8f6f0f9d11";
    decide.mockImplementation(async (id) => {
      if (id === poison) throw new Error('invalid input syntax for type uuid: "nope"');
      return true;
    });
    polling({ attempts: 3, ms: 0, delayMs: () => 20 });
    const pressed = standIn.press(`ap:${poison}:y`);
    const next = standIn.say("Are you there?");
    await until(() => standIn.acknowledged >= next, "both updates were acknowledged");
    expect(decide).toHaveBeenCalledTimes(3);
    expect(standIn.acknowledged).toBeGreaterThan(pressed);
    expect(await saved("Are you there?")).toHaveLength(1);
    const [notice] = await db.select().from(notifications);
    expect(notice).toMatchObject({
      kind: "telegram_skipped",
      title: "A Telegram message was skipped",
    });
    expect(notice!.body).toMatch(/^Pressing a button on Telegram kept failing/);
    expect(notice!.body).toContain("invalid input syntax");
    // You hear it on Telegram too, where you sent it.
    await until(
      () => standIn.texts().some((text) => text.includes("A Telegram message was skipped")),
      "Telegram was told",
    );
    expect(ctx.log.error).toHaveBeenCalledWith(
      "skipped a Telegram update that kept failing",
      expect.objectContaining({ updateId: pressed, attempts: 3 }),
    );
  });
});
