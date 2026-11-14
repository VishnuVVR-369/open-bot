import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as schema from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import type { ComputerHealth } from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ComputerClient } from "../../computer/client";
import type { Context } from "../../context";
import type { Logger } from "../../logger";
import { SessionRegistry } from "../../runs/registry";
import { ScreenOperationService } from "./screen-operations";
import { TakeoverService } from "./takeovers";

// This worker against a computer that refuses a call before acting on it, like the next computer
// version, which moves your lease's routes and code entry (`/lease/user/*` and `/computer/type`
// answer 404 there). The worker and the computer deploy separately, so this worker can meet that
// computer: a refusal must leave nothing recorded, no request closed and no run continued.

// This branch's names for the teammate and screen takeover tables.
const teammatesTable = schema.bots; // vocabulary: allow (renamed with the tables)
const screenTakeovers = schema.desktopTakeovers; // vocabulary: allow (renamed with the tables)
const { chats, runs, screenOperations } = schema;

const since = "2026-11-14T00:00:00.000Z";
const OWNER = { kind: "user", since, lastInputAt: since } as const;
const HEALTH: ComputerHealth = {
  ok: true,
  bootedAt: since,
  agent: "running",
  screens: [],
  egress: { mode: "off", agentOnline: false, tunnelConnected: false },
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * A computer that serves its health, its events and the code's site check, and answers 404 to
 * everything else, as the next version does for the routes it moved.
 */
async function refusingComputer(screenId: string) {
  const state = { owner: false, handled: [] as string[] };
  const health = () => ({
    ...HEALTH,
    screens: [
      { id: screenId, state: "running", browser: "running", lease: state.owner ? OWNER : null },
    ],
  });
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    const path = new URL(request.url!, "http://botd").pathname;
    const answer =
      request.method === "GET" && path === "/health"
        ? health()
        : request.method === "POST" && path === "/computer/code-context"
          ? { site: "example.com" }
          : undefined;
    if (answer && request.method === "POST") state.handled.push(path);
    response.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(answer ?? { error: "not found", code: "NOT_FOUND" }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  const connected: WebSocket[] = [];
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (ws) => {
      connected.push(ws);
      ws.send(JSON.stringify({ type: "lease", screenId, holder: state.owner ? OWNER : null }));
      ws.send(JSON.stringify({ type: "health", health: health() }));
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const ws of connected) ws.terminate();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

function logger(): Logger {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
}

const url = testDatabaseServer();
describe.skipIf(!url)("a computer that refuses a call before acting on it", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  beforeAll(async () => {
    await database.create();
  });
  afterAll(async () => {
    await database.drop();
  });

  /** A teammate with a finished run, and the services against a refusing computer. */
  async function setUp() {
    const [teammate] = await db
      .insert(teammatesTable)
      .values({ name: "Rex", slug: `rex-${randomUUID()}`, role: "Test", color: "#123456" })
      .returning();
    const screenId = teammate!.id;
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: "Rex", botId: screenId }) // vocabulary: allow (column)
      .returning();
    const [run] = await db
      .insert(runs)
      .values({
        chatId: chat!.id,
        botId: screenId, // vocabulary: allow (column)
        trigger: "user",
        prompt: "Sign in to the airline",
        status: "completed",
      })
      .returning();
    const botd = await refusingComputer(screenId);
    const computer = new ComputerClient(botd.url, "secret", logger());
    cleanup.push(() => computer.stop());
    const ctx = {
      db,
      pool,
      computer,
      events: new EventEmitter(),
      log: logger(),
    } as unknown as Context;
    const takeovers = new TakeoverService(ctx, new SessionRegistry());
    const rows = () =>
      db.select().from(screenTakeovers).where(eq(screenTakeovers.screenId, screenId));
    const continuations = () =>
      db
        .select()
        .from(runs)
        .where(and(eq(runs.parentRunId, run!.id), eq(runs.trigger, "hand_back")));
    return { screenId, run: run!, botd, computer, ctx, takeovers, rows, continuations };
  }

  it("leaves a code request open when the computer refuses the code, even after reconciling", async () => {
    const { screenId, run, botd, computer, ctx, takeovers, rows, continuations } = await setUp();
    const [request] = await db
      .insert(screenTakeovers)
      .values({
        screenId,
        status: "requested",
        requestedByRunId: run.id,
        requestedByBotId: screenId, // vocabulary: allow (column)
        reason: "Enter the code the airline sent",
        itemId: randomUUID(),
      })
      .returning();
    const operations = new ScreenOperationService(ctx, takeovers);
    const operationId = randomUUID();
    const operation = await operations.type({
      takeoverId: request!.id,
      operationId,
      expectedSite: "example.com",
      pressEnter: true,
      text: "582913",
    });
    expect(operation).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("nothing was typed"),
    });
    expect(botd.state.handled).toEqual(["/computer/code-context"]);
    expect(await rows()).toMatchObject([{ id: request!.id, status: "requested" }]);

    // The reconciler finds nothing to end: no takeover was recorded for a screen you don't hold.
    computer.start();
    await vi.waitFor(() => expect(computer.online).toBe(true));
    await takeovers.reconcile();
    expect(await rows()).toMatchObject([{ id: request!.id, status: "requested" }]);
    const [stored] = await db
      .select()
      .from(screenOperations)
      .where(eq(screenOperations.id, operationId));
    expect(stored).toMatchObject({ status: "failed" });
    expect(await continuations()).toEqual([]);
  });

  it("records no takeover when the computer refuses to give you the screen", async () => {
    const { screenId, botd, takeovers, rows } = await setUp();
    await expect(takeovers.take(screenId)).rejects.toMatchObject({ status: 404 });
    expect(botd.state.handled).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("keeps the takeover open and continues nothing when the computer refuses the hand-back", async () => {
    const { screenId, run, botd, takeovers, rows, continuations } = await setUp();
    botd.state.owner = true;
    await db.insert(screenTakeovers).values({
      screenId,
      status: "active",
      startedAt: new Date(),
      interruptedRunId: run.id,
    });
    await expect(takeovers.handBack(screenId, "Logged in for you")).rejects.toMatchObject({
      status: 404,
    });
    expect(botd.state.handled).toEqual([]);
    expect(await rows()).toMatchObject([{ status: "active" }]);
    expect(await continuations()).toEqual([]);
  });

  it("changes nothing when the computer refuses your input report", async () => {
    const { screenId, botd, computer, rows } = await setUp();
    botd.state.owner = true;
    await expect(computer.touchUser(screenId)).rejects.toMatchObject({ status: 404 });
    expect(botd.state.handled).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});
