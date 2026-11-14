import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { botdContract } from "@open-bot/api/botd";
import { chats, runs, screenTakeovers, teammates } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import type { ComputerHealth } from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ComputerClient } from "../../computer/client";
import type { Context } from "../../context";
import type { Logger } from "../../logger";
import { SessionRegistry } from "../../runs/registry";
import { TakeoverService } from "./takeovers";

// `TakeoverService` with the real `ComputerClient` against a stand-in computer that keeps its
// leases like botd does, on either side of the run lease's rename: `old` serves your lease on
// `/lease/user/*` and names a run's teammate with the old keys, `current` serves the
// contract's routes and names. While the worker and the computer run different versions, taking
// over and handing back must fail before a screen changes hands, so that once both match, the run
// you interrupted is continued exactly once.

const since = "2026-11-14T00:00:00.000Z";
const OWNER = { kind: "user", since, lastInputAt: since } as const;
const HEALTH: ComputerHealth = {
  ok: true,
  bootedAt: since,
  agent: "running",
  screens: [],
  egress: { mode: "off", agentOnline: false, tunnelConnected: false },
};

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
    /** Lease calls a handler acted on, in order. */
    handled: [] as string[],
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
  const routes = {
    old: { "/lease/user/take": take, "/lease/user/release": release, "/lease/user/touch": touch },
    current: {
      [pathOf(botdContract.leases.take)]: take,
      [pathOf(botdContract.leases.release)]: release,
      [pathOf(botdContract.leases.touch)]: touch,
    },
  };
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    const path = new URL(request.url!, "http://botd").pathname;
    const health = () => ({
      ...HEALTH,
      screens: [{ id: screenId, state: "running", browser: "running", lease: lease(state.holder) }],
    });
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
        prompt: "Book the flight",
        status: "completed",
      })
      .returning();
    const botd = await computerStandIn(screenId);
    botd.state.holder = {
      kind: "run",
      run: { runId: run!.id, teammateId: screenId, teammateName: "Rex" },
    };
    const computer = new ComputerClient(botd.url, "secret", logger());
    cleanup.push(() => computer.stop());
    const ctx = { db, pool, computer, events: new EventEmitter(), log: logger() };
    const service = new TakeoverService(ctx as unknown as Context, new SessionRegistry());
    const takeovers = () =>
      db.select().from(screenTakeovers).where(eq(screenTakeovers.screenId, screenId));
    const continuations = () =>
      db
        .select()
        .from(runs)
        .where(and(eq(runs.parentRunId, run!.id), eq(runs.trigger, "hand_back")));
    return { screenId, run: run!, botd, computer, service, takeovers, continuations };
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

  it("keeps your note when handing back is refused and the computer's restart ends the takeover", async () => {
    const { screenId, run, botd, computer, service, takeovers, continuations } = await setUp();
    // You took over while both ran the old version; then the worker was deployed.
    botd.state.holder = { kind: "owner" };
    await db.insert(screenTakeovers).values({
      screenId,
      status: "active",
      startedAt: new Date(),
      interruptedRunId: run.id,
    });
    computer.start();
    await vi.waitFor(() => expect(computer.lease(screenId)).toEqual(OWNER));
    await expect(service.handBack(screenId, "Logged in for you")).rejects.toMatchObject({
      status: 404,
    });
    expect(botd.state.handled).toEqual([]);
    expect(botd.state.holder).toEqual({ kind: "owner" });
    expect(await continuations()).toEqual([]);
    botd.restart();
    await vi.waitFor(async () => expect(await continuations()).toHaveLength(1));
    expect((await continuations())[0]!.prompt).toContain('Their note: "Logged in for you"');
    expect(await takeovers()).toMatchObject([{ status: "ended", note: "Logged in for you" }]);
  });
});
