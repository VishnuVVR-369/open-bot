import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { botdContract } from "@open-bot/api/botd";
import {
  chats,
  runs,
  screenOperations,
  screenTakeovers,
  takeoverDeliveries,
  teammates,
} from "@open-bot/db";
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
import { CODE_HANDED_BACK_NOTE, TakeoverService } from "./takeovers";

// `TakeoverService` and `ScreenOperationService` with the real `ComputerClient` against a stand-in
// computer that keeps its leases like botd does, on either side of the run lease's rename: `old`
// serves the routes that take a screen for you at their old paths and names a run's teammate with
// the old keys, `current` serves the contract's routes and names. While the worker and the computer
// run different versions, taking over, typing a code and handing back must fail before a screen
// changes hands, so that once both match, every run you interrupted is continued exactly once.

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

type Run = { runId: string; teammateId: string; teammateName: string };
type Holder = { kind: "owner" } | { kind: "run"; run: Run } | null;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function pathOf(procedure: { "~orpc": { route: { path?: string } } }): string {
  return procedure["~orpc"].route.path!;
}

async function computerStandIn(screenId: string) {
  const state = {
    version: "old" as "old" | "current",
    holder: null as Holder,
    /** POST calls a handler acted on, in order. */
    handled: [] as string[],
    /** Runs when you ask for the code's site: after the worker read the lease, before typing. */
    onCodeContext: () => {},
  };
  const lease = (holder: Holder) => {
    if (holder === null) return null;
    if (holder.kind === "owner") return OWNER;
    const { runId, teammateId, teammateName } = holder.run;
    const named =
      state.version === "old"
        ? { botId: teammateId, botName: teammateName } // vocabulary: allow (the old keys)
        : { teammateId, teammateName };
    return { kind: "run", runId, ...named, since, lastActionAt: since };
  };
  const take = () => {
    const previous = state.holder;
    state.holder = { kind: "owner" };
    return { previous: lease(previous), holder: lease(state.holder) };
  };
  const release = () => {
    if (state.holder?.kind === "owner") state.holder = null;
    return { released: true };
  };
  const touch = () => ({ holder: lease(state.holder) });
  const codeContext = () => {
    state.onCodeContext();
    return { site: "example.com" };
  };
  // botd takes the screen for you while it types, preempting any run, and the code is checked gone.
  const typeCode = () => {
    if (state.holder?.kind === "owner") return { status: "failed", reason: "In use by you." };
    const previous = state.holder;
    state.holder = { kind: "owner" };
    return { status: "safe", reason: null, previous: lease(previous) };
  };
  const routes = {
    old: {
      "/lease/user/take": take,
      "/lease/user/release": release,
      "/lease/user/touch": touch,
      "/computer/code-context": codeContext,
      "/computer/type": typeCode,
    },
    current: {
      [pathOf(botdContract.leases.take)]: take,
      [pathOf(botdContract.leases.release)]: release,
      [pathOf(botdContract.leases.touch)]: touch,
      [pathOf(botdContract.computer.codeContext)]: codeContext,
      [pathOf(botdContract.computer.type)]: typeCode,
    },
  };
  const health = () => ({
    ...HEALTH,
    screens: [{ id: screenId, state: "running", browser: "running", lease: lease(state.holder) }],
  });
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    const path = new URL(request.url!, "http://botd").pathname;
    const handler =
      request.method === "GET" && path === "/health"
        ? health
        : request.method === "POST"
          ? (routes[state.version] as Record<string, () => unknown>)[path]
          : undefined;
    if (request.method === "POST" && handler) state.handled.push(path);
    response.writeHead(handler ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(handler ? handler() : { error: "not found", code: "NOT_FOUND" }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  const connected: WebSocket[] = [];
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (ws) => {
      connected.push(ws);
      // Current state first, like botd.
      ws.send(JSON.stringify({ type: "lease", screenId, holder: lease(state.holder) }));
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
    /** The computer restarted on its new version: every lease is gone and the screen stopped. */
    restart() {
      state.version = "current";
      state.holder = null;
      for (const ws of connected) ws.send(JSON.stringify({ type: "health", health: HEALTH }));
    },
    /** botd took your lease back on its own: you went idle, or your control connection was gone. */
    expire(reason: LeaseReleaseReason) {
      state.holder = null;
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
describe.skipIf(!url)("takeovers across a worker and a computer on different versions", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  beforeAll(async () => {
    await database.create();
  });
  afterAll(async () => {
    await database.drop();
  });

  /** A teammate whose run was using its screen and ended after you took over. */
  async function setUp() {
    const [teammate] = await db
      .insert(teammates)
      .values({ name: "Rex", slug: `rex-${randomUUID()}`, role: "Test", color: "#123456" })
      .returning();
    const screenId = teammate!.id;
    const addRun = async (prompt: string) => {
      const [chat] = await db
        .insert(chats)
        .values({ kind: "direct", title: "Rex", teammateId: screenId })
        .returning();
      const [run] = await db
        .insert(runs)
        .values({
          chatId: chat!.id,
          teammateId: screenId,
          trigger: "user",
          prompt,
          status: "completed",
        })
        .returning();
      return run!;
    };
    const run = await addRun("Book the flight");
    const botd = await computerStandIn(screenId);
    botd.state.holder = {
      kind: "run",
      run: { runId: run.id, teammateId: screenId, teammateName: "Rex" },
    };
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
      return { computer, ctx, service: new TakeoverService(ctx, new SessionRegistry()) };
    };
    const { computer, ctx, service } = worker();
    const takeovers = () =>
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
      computer,
      ctx,
      service,
      takeovers,
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
   * Another run of the teammate asked you for a one-time code, and the screen was free when the
   * worker looked; then `run`, started by a worker of the other version, took it before typing.
   */
  async function setUpCodeEntry() {
    const setup = await setUp();
    const { screenId, run, addRun, botd, ctx, service } = setup;
    const requester = await addRun("Sign in to the airline");
    const [request] = await db
      .insert(screenTakeovers)
      .values({
        screenId,
        status: "requested",
        requestedByRunId: requester.id,
        requestedByTeammateId: screenId,
        reason: "Enter the code the airline sent",
        itemId: randomUUID(),
      })
      .returning();
    botd.state.holder = null;
    botd.state.onCodeContext = () => {
      botd.state.holder = {
        kind: "run",
        run: { runId: run.id, teammateId: screenId, teammateName: "Rex" },
      };
    };
    const operations = new ScreenOperationService(ctx, service);
    const input = {
      takeoverId: request!.id,
      operationId: randomUUID(),
      expectedSite: "example.com",
      pressEnter: true,
      text: "582913",
    };
    return { ...setup, requester, operations, input };
  }

  it("refuses a takeover on a computer of the other version before the screen changes hands", async () => {
    const { screenId, run, botd, service, takeovers } = await setUp();
    await expect(service.take(screenId)).rejects.toMatchObject({ status: 404 });
    expect(botd.state.handled).toEqual([]);
    expect(botd.state.holder).toMatchObject({ kind: "run", run: { runId: run.id } });
    expect(await takeovers()).toEqual([]);
  });

  it("continues the interrupted run once: take refused, then take, retry and hand back", async () => {
    const { screenId, run, botd, service, takeovers, continuations } = await setUp();
    await expect(service.take(screenId)).rejects.toThrow();
    // The other side catches up, with the run still holding the screen.
    botd.state.version = "current";
    await service.take(screenId);
    // You press "Take over" again, like after an error: you are the holder botd reports now.
    await service.take(screenId);
    expect(botd.state.handled).toEqual([
      pathOf(botdContract.leases.take),
      pathOf(botdContract.leases.take),
    ]);
    expect(await takeovers()).toMatchObject([{ status: "active", interruptedRunId: run.id }]);
    await service.handBack(screenId, "Logged in for you");
    expect(await takeovers()).toMatchObject([{ status: "ended", endReason: "handed_back" }]);
    const continued = await continuations();
    expect(continued).toHaveLength(1);
    expect(continued[0]!.prompt).toContain('Their note: "Logged in for you"');
  });

  it("refuses a code on a computer of the other version before anything is typed", async () => {
    const { run, botd, operations, input, takeovers } = await setUpCodeEntry();
    expect(await operations.type(input)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("nothing was typed"),
    });
    expect(botd.state.handled).toEqual(["/computer/code-context"]);
    // The run that took the screen keeps it, and the request waits for you as before.
    expect(botd.state.holder).toMatchObject({ kind: "run", run: { runId: run.id } });
    expect(await takeovers()).toMatchObject([{ status: "requested", interruptedRunId: null }]);
  });

  it("continues the run a code entry preempted, and the run that asked for the code", async () => {
    const { run, requester, botd, operations, input, takeovers, continuationsOf } =
      await setUpCodeEntry();
    botd.state.version = "current";
    expect(await operations.type(input)).toMatchObject({ status: "handed_back" });
    expect(await takeovers()).toMatchObject([
      { status: "ended", interruptedRunId: run.id, requestedByRunId: requester.id },
    ]);
    for (const runId of [run.id, requester.id]) {
      const continued = await continuationsOf(runId);
      expect(continued, runId).toHaveLength(1);
      expect(continued[0]!.prompt).toContain(CODE_HANDED_BACK_NOTE);
    }
  });

  const endings = [
    { ending: "the computer's restart", auto: null },
    { ending: "your going idle", auto: "user_idle", says: "10 minutes without input" },
    { ending: "a lost connection", auto: "user_disconnected", says: "screen view disconnected" },
  ] as const;
  it.each(endings)(
    "delivers your refused hand-back's note once when $ending ends the takeover",
    async (ending) => {
      const { screenId, run, botd, computer, service, takeovers, continuations } = await setUp();
      // You took over while both ran the old version; then the worker was deployed.
      botd.state.holder = { kind: "owner" };
      const [takeover] = await db
        .insert(screenTakeovers)
        .values({ screenId, status: "active", startedAt: new Date(), interruptedRunId: run.id })
        .returning();
      computer.start();
      await vi.waitFor(() => expect(computer.lease(screenId)).toEqual(OWNER));
      await expect(service.handBack(screenId, NOTE)).rejects.toMatchObject({ status: 404 });
      expect(botd.state.handled).toEqual([]);
      expect(botd.state.holder).toEqual({ kind: "owner" });
      expect(await continuations()).toEqual([]);
      if (ending.auto) botd.expire(ending.auto);
      else botd.restart();
      await delivered(takeover!.id);
      expect(await takeovers()).toMatchObject([{ status: "ended", note: NOTE }]);
      // Reconciling later delivers nothing again.
      await service.reconcile();
      const continued = await continuations();
      expect(continued).toHaveLength(1);
      expect(continued[0]!.prompt).toContain(NOTE);
      if (ending.auto) expect(continued[0]!.prompt).toContain(ending.says);
    },
  );

  type Order = { created: "takeover" | "request"; read: "takeover" | "request" };

  /**
   * You hold the screen for `run`; a hand-back the old computer refused saved `NOTE` on your
   * takeover (as the tests above show), and a request from another run then joined it with no note
   * of its own. `created` is the row with the older creation time, and `read` the one a query
   * without an order returns first: Postgres returns rows where it stored them, which a fresh
   * table follows from insertion and a used one from wherever it found free space.
   */
  async function setUpJoinedRequest(order: Order) {
    const setup = await setUp();
    const { screenId, run, addRun, botd, computer } = setup;
    const requester = await addRun("Sign in to the airline");
    botd.state.holder = { kind: "owner" };
    computer.start();
    await vi.waitFor(() => expect(computer.lease(screenId)).toEqual(OWNER));
    const at = (row: Order["created"]) =>
      new Date(Date.parse(since) + (order.created === row ? 0 : 1000));
    const values = {
      takeover: {
        screenId,
        status: "active" as const,
        startedAt: new Date(),
        interruptedRunId: run.id,
        note: NOTE,
        endReason: "handed_back" as const,
        createdAt: at("takeover"),
      },
      request: {
        screenId,
        status: "active" as const,
        startedAt: new Date(),
        requestedByRunId: requester.id,
        requestedByTeammateId: screenId,
        reason: "Enter the code the airline sent",
        itemId: randomUUID(),
        createdAt: at("request"),
      },
    };
    const second = order.read === "takeover" ? "request" : "takeover";
    const [first] = await db.insert(screenTakeovers).values(values[order.read]).returning();
    const [then] = await db.insert(screenTakeovers).values(values[second]).returning();
    const ids = { [order.read]: first!.id, [second]: then!.id } as Record<Order["read"], string>;
    const unordered = await db
      .select({ id: screenTakeovers.id, note: screenTakeovers.note })
      .from(screenTakeovers)
      .where(and(eq(screenTakeovers.status, "active"), eq(screenTakeovers.screenId, screenId)));
    expect(unordered).toEqual([
      { id: ids[order.read], note: order.read === "takeover" ? NOTE : null },
      { id: ids[second], note: second === "takeover" ? NOTE : null },
    ]);
    return { ...setup, requester, takeoverId: ids.takeover, requestId: ids.request };
  }

  const orders: Order[] = [
    // The reviewer's case: the request joined later, and its row is the one read first.
    { created: "takeover", read: "request" },
    { created: "request", read: "request" },
    { created: "takeover", read: "takeover" },
    { created: "request", read: "takeover" },
  ];
  it.each(orders)(
    "tells every run in the return your saved note (older: $created, read first: $read)",
    async (order) => {
      const { run, requester, botd, takeoverId, requestId, continuationsOf } =
        await setUpJoinedRequest(order);
      botd.expire("user_idle");
      await delivered(takeoverId);
      await delivered(requestId);
      for (const runId of [run.id, requester.id]) {
        const continued = await continuationsOf(runId);
        expect(continued, runId).toHaveLength(1);
        expect(continued[0]!.prompt, runId).toContain(NOTE);
        expect(continued[0]!.prompt, runId).toContain("10 minutes without input");
      }
    },
  );

  it("keeps your saved note when reconcile hands back a code typed for a request that joined later", async () => {
    const { screenId, run, requester, botd, service, requestId, continuationsOf } =
      await setUpJoinedRequest({ created: "takeover", read: "request" });
    // The code was typed and the screen checked safe, then the worker stopped before handing back.
    botd.state.version = "current";
    await db
      .insert(screenOperations)
      .values({ id: randomUUID(), takeoverId: requestId, screenId, status: "safe" });
    await service.reconcile();
    await delivered(requestId);
    for (const runId of [run.id, requester.id]) {
      const continued = await continuationsOf(runId);
      expect(continued, runId).toHaveLength(1);
      expect(continued[0]!.prompt, runId).toContain(NOTE);
      expect(continued[0]!.prompt, runId).not.toContain(CODE_HANDED_BACK_NOTE);
    }
  });

  it.each(endings)(
    "delivers once the note the new worker saved before the old computer refused its hand-back, when the old worker sees $ending",
    async (ending) => {
      const { screenId, run, botd, worker, takeovers, continuations } = await setUp();
      // You took over while everything ran the old version. Then the new worker started next to
      // the old one, and only the old one is connected to the computer, so it sees your lease end.
      // It runs this takeover code: #171 brings the same code to the old worker before this ships.
      botd.state.holder = { kind: "owner" };
      const [takeover] = await db
        .insert(screenTakeovers)
        .values({ screenId, status: "active", startedAt: new Date(), interruptedRunId: run.id })
        .returning();
      const older = worker();
      older.computer.start();
      await vi.waitFor(() => expect(older.computer.lease(screenId)).toEqual(OWNER));
      const newer = worker();
      await expect(newer.service.handBack(screenId, NOTE)).rejects.toMatchObject({ status: 404 });
      expect(botd.state.handled).toEqual([]);
      expect(await takeovers()).toMatchObject([{ status: "active", note: NOTE }]);
      if (ending.auto) botd.expire(ending.auto);
      else botd.restart();
      await delivered(takeover!.id);
      expect(await takeovers()).toMatchObject([{ status: "ended", note: NOTE }]);
      // Reconciling afterwards, in either worker, delivers nothing again.
      await older.service.reconcile();
      await newer.service.reconcile();
      const continued = await continuations();
      expect(continued).toHaveLength(1);
      expect(continued[0]!.prompt).toContain(NOTE);
      if (ending.auto) expect(continued[0]!.prompt).toContain(ending.says);
    },
  );

  it("keeps the note a refused hand-back saved after a reconcile read the takeovers", async () => {
    const { screenId, run, botd, computer, ctx, service, takeovers, continuations } = await setUp();
    // Another teammate's takeover on a screen nobody holds any more. Reconcile visits screens in
    // id order, so it comes first, while yours waits as reconcile read it.
    const otherId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    await db
      .insert(teammates)
      .values({ id: otherId, name: "Ada", slug: `ada-${otherId}`, role: "Test", color: "#123456" });
    await db
      .insert(screenTakeovers)
      .values({ screenId: otherId, status: "active", startedAt: new Date() });
    // You took over while both ran the old version; then the worker was deployed.
    botd.state.holder = { kind: "owner" };
    const [takeover] = await db
      .insert(screenTakeovers)
      .values({ screenId, status: "active", startedAt: new Date(), interruptedRunId: run.id })
      .returning();
    computer.start();
    await vi.waitFor(() => expect(computer.online).toBe(true));

    // Reconcile reads the active takeovers, then stops at its first health read, for Ada's screen.
    let reached!: () => void;
    const atHealth = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const fetchHealth = computer.fetchHealth.bind(computer);
    vi.spyOn(computer, "fetchHealth").mockImplementationOnce(async () => {
      reached();
      await held;
      return fetchHealth();
    });
    const reconciling = service.reconcile();
    await atHealth;
    // You hand back through the screen lock, like the worker's route; the old computer refuses.
    await expect(
      withScreenLock(ctx, screenId, () => service.handBack(screenId, NOTE)),
    ).rejects.toMatchObject({ status: 404 });
    expect(await takeovers()).toMatchObject([{ status: "active", note: NOTE }]);
    // Then your lease ends on the computer, and reconcile sees that before its event arrives.
    botd.state.holder = null;
    resume();
    await reconciling;

    await delivered(takeover!.id);
    expect(await takeovers()).toMatchObject([{ status: "ended", note: NOTE }]);
    const continued = await continuations();
    expect(continued).toHaveLength(1);
    expect(continued[0]!.prompt).toContain(NOTE);
  });
});
