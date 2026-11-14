import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as schema from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import type { ComputerHealth, LeaseReleaseReason } from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ComputerClient } from "../../computer/client";
import type { Context } from "../../context";
import type { Logger } from "../../logger";
import { SessionRegistry } from "../../runs/registry";
import { withScreenLock } from "./screen-lock";
import { ScreenOperationService } from "./screen-operations";
import { TakeoverService } from "./takeovers";

// This worker against a computer that refuses a call before acting on it, like the next computer
// version, which moves your lease's routes and code entry (`/lease/user/*` and `/computer/type`
// answer 404 there). The worker and the computer deploy separately, so this worker can meet that
// computer: a refusal must leave nothing recorded, no request closed and no run continued.
// While the next worker deploys, it runs next to this one on the same database, and its hand-back
// to this computer is refused the same way after it saved your note: this worker, which may be the
// one that sees the lease end, must keep that note and deliver it once.

// This branch's names for the teammate and screen takeover tables.
const teammatesTable = schema.bots; // vocabulary: allow (renamed with the tables)
const screenTakeovers = schema.desktopTakeovers; // vocabulary: allow (renamed with the tables)
const { chats, runs, screenOperations, takeoverDeliveries } = schema;

const since = "2026-11-14T00:00:00.000Z";
const OWNER = { kind: "user", since, lastInputAt: since } as const;
const HEALTH: ComputerHealth = {
  ok: true,
  bootedAt: since,
  agent: "running",
  screens: [],
  egress: { mode: "off", agentOnline: false, tunnelConnected: false },
};
const NOTE = "Only nonstop flights, window seat";

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
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    /** The computer restarted: every lease is gone and the screen stopped. */
    restart() {
      state.owner = false;
      for (const ws of connected) ws.send(JSON.stringify({ type: "health", health: HEALTH }));
    },
    /** botd took your lease back on its own: you went idle, or your control connection was gone. */
    expire(reason: LeaseReleaseReason) {
      state.owner = false;
      for (const ws of connected)
        ws.send(JSON.stringify({ type: "lease", screenId, holder: null, reason }));
    },
  };
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

  /** A teammate with a finished run, and the services of a worker against a refusing computer. */
  async function setUp() {
    const [teammate] = await db
      .insert(teammatesTable)
      .values({ name: "Rex", slug: `rex-${randomUUID()}`, role: "Test", color: "#123456" })
      .returning();
    const screenId = teammate!.id;
    const addRun = async (prompt: string) => {
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
          prompt,
          status: "completed",
        })
        .returning();
      return run!;
    };
    const run = await addRun("Sign in to the airline");
    const botd = await refusingComputer(screenId);
    /** One worker process: its own connection to the computer, and the shared database. */
    const worker = () => {
      const computer = new ComputerClient(botd.url, "secret", logger());
      cleanup.push(() => computer.stop());
      const ctx = {
        db,
        pool,
        computer,
        events: new EventEmitter(),
        log: logger(),
      } as unknown as Context;
      return { computer, ctx, takeovers: new TakeoverService(ctx, new SessionRegistry()) };
    };
    const rows = () =>
      db.select().from(screenTakeovers).where(eq(screenTakeovers.screenId, screenId));
    const continuationsOf = (runId: string) =>
      db
        .select()
        .from(runs)
        .where(and(eq(runs.parentRunId, runId), eq(runs.trigger, "hand_back")));
    const continuations = () => continuationsOf(run.id);
    return {
      screenId,
      run,
      addRun,
      botd,
      worker,
      ...worker(),
      rows,
      continuationsOf,
      continuations,
    };
  }

  /** The takeover's return, once its delivery is marked done: enqueueing a run comes before that. */
  async function delivered(takeoverId: string) {
    await vi.waitFor(async () => {
      const [delivery] = await db
        .select()
        .from(takeoverDeliveries)
        .where(eq(takeoverDeliveries.id, takeoverId));
      expect(delivery?.deliveredAt).toBeInstanceOf(Date);
    });
  }

  /**
   * You took over the screen from `run` while both workers ran this version. `older` is this
   * worker, connected to the computer and so the one that sees your lease end; `newer` is the next
   * worker deploying next to it, whose hand-back the computer refuses.
   */
  async function setUpTwoWorkers() {
    const setup = await setUp();
    const { screenId, run, botd, worker } = setup;
    botd.state.owner = true;
    const [takeover] = await db
      .insert(screenTakeovers)
      .values({ screenId, status: "active", startedAt: new Date(), interruptedRunId: run.id })
      .returning();
    const older = worker();
    older.computer.start();
    await vi.waitFor(() => expect(older.computer.lease(screenId)).toEqual(OWNER));
    return { ...setup, takeover: takeover!, older, newer: worker() };
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

  const endings = [
    { ending: "the computer's restart", auto: null },
    { ending: "your going idle", auto: "user_idle", says: "10 minutes without input" },
    { ending: "a lost connection", auto: "user_disconnected", says: "view disconnected" },
  ] as const;
  it.each(endings)(
    "delivers once the note another worker saved before its hand-back was refused, when this worker sees $ending",
    async (ending) => {
      const { screenId, botd, takeover, older, newer, rows, continuations } =
        await setUpTwoWorkers();
      await expect(newer.takeovers.handBack(screenId, NOTE)).rejects.toMatchObject({
        status: 404,
      });
      expect(await rows()).toMatchObject([{ status: "active", note: NOTE }]);
      if (ending.auto) botd.expire(ending.auto);
      else botd.restart();
      await delivered(takeover.id);
      expect(await rows()).toMatchObject([{ status: "ended", note: NOTE }]);
      // Reconciling afterwards, in either worker, delivers nothing again.
      await older.takeovers.reconcile();
      await newer.takeovers.reconcile();
      const continued = await continuations();
      expect(continued).toHaveLength(1);
      expect(continued[0]!.prompt).toContain(NOTE);
      if (ending.auto) expect(continued[0]!.prompt).toContain(ending.says);
    },
  );

  it("keeps the note another worker saved while this worker's reconcile had read the takeovers", async () => {
    const { screenId, botd, takeover, older, newer, rows, continuations } = await setUpTwoWorkers();
    // Another teammate's takeover on a screen nobody holds any more, visited first, so reconcile
    // stops there while yours waits as it read it.
    const otherId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    await db
      .insert(teammatesTable)
      .values({ id: otherId, name: "Ada", slug: `ada-${otherId}`, role: "Test", color: "#123456" });
    await db
      .insert(screenTakeovers)
      .values({ screenId: otherId, status: "active", startedAt: new Date() });
    let reached!: () => void;
    const atHealth = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const fetchHealth = older.computer.fetchHealth.bind(older.computer);
    vi.spyOn(older.computer, "fetchHealth").mockImplementationOnce(async () => {
      reached();
      await held;
      return fetchHealth();
    });
    const reconciling = older.takeovers.reconcile();
    await atHealth;
    // The other worker hands back through the screen lock, like its route; the computer refuses.
    await expect(
      withScreenLock(newer.ctx, screenId, () => newer.takeovers.handBack(screenId, NOTE)),
    ).rejects.toMatchObject({ status: 404 });
    // Then your lease ends on the computer, and reconcile sees that before its event arrives.
    botd.state.owner = false;
    resume();
    await reconciling;

    await delivered(takeover.id);
    expect(await rows()).toMatchObject([{ status: "ended", note: NOTE }]);
    const continued = await continuations();
    expect(continued).toHaveLength(1);
    expect(continued[0]!.prompt).toContain(NOTE);
  });

  it("tells every run in the return the saved note when a request without one is read first", async () => {
    const { screenId, run, addRun, botd, worker, continuationsOf } = await setUp();
    const requester = await addRun("Book the flight");
    botd.state.owner = true;
    // Your takeover as another worker's refused hand-back left it, and a request that joined it
    // after, stored where a query without an order reads it first.
    const [request] = await db
      .insert(screenTakeovers)
      .values({
        screenId,
        status: "active",
        startedAt: new Date(),
        requestedByRunId: requester.id,
        requestedByBotId: screenId, // vocabulary: allow (column)
        reason: "Enter the code the airline sent",
        itemId: randomUUID(),
        createdAt: new Date(Date.parse(since) + 1000),
      })
      .returning();
    const [takeover] = await db
      .insert(screenTakeovers)
      .values({
        screenId,
        status: "active",
        startedAt: new Date(),
        interruptedRunId: run.id,
        note: NOTE,
        endReason: "handed_back",
        createdAt: new Date(Date.parse(since)),
      })
      .returning();
    const unordered = await db
      .select({ id: screenTakeovers.id })
      .from(screenTakeovers)
      .where(and(eq(screenTakeovers.status, "active"), eq(screenTakeovers.screenId, screenId)));
    expect(unordered).toEqual([{ id: request!.id }, { id: takeover!.id }]);
    const older = worker();
    older.computer.start();
    await vi.waitFor(() => expect(older.computer.lease(screenId)).toEqual(OWNER));
    botd.expire("user_idle");
    await delivered(takeover!.id);
    await delivered(request!.id);
    for (const runId of [run.id, requester.id]) {
      const continued = await continuationsOf(runId);
      expect(continued, runId).toHaveLength(1);
      expect(continued[0]!.prompt, runId).toContain(NOTE);
      expect(continued[0]!.prompt, runId).toContain("10 minutes without input");
    }
  });
});
