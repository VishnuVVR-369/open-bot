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
import type { CodeEntryResult, ComputerHealth } from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ComputerClient } from "../../computer/client";
import type { Context } from "../../context";
import type { Logger } from "../../logger";
import { SessionRegistry } from "../../runs/registry";
import { ScreenOperationService } from "./screen-operations";
import { TakeoverService } from "./takeovers";

// "Type the code" when the worker never hears botd's answer, through the real `ComputerClient`
// against a stand-in computer that keeps leases and code entries like botd: the request can be lost
// before botd acts, its answer lost after botd typed, botd can refuse with a 500 while it stops, and
// the worker can restart while botd types. In each case the screen must end up either held by you,
// with a takeover whose hand-back answers the teammate's request, or free with the request still
// open, never with a hand-back that didn't happen.

const since = "2026-11-22T00:00:00.000Z";
const CODE_HOLDER = { kind: "user-code", since, lastInputAt: since } as const;
const HEALTH: ComputerHealth = {
  ok: true,
  bootedAt: since,
  agent: "running",
  screens: [],
  egress: { mode: "off", agentOnline: false, tunnelConnected: false },
};
const NEVER_GOT = "The computer never got the code, so nothing was typed. Send it again.";
const TYPED = "The code may still be on the page. Check the screen, then hand back.";
/** How long to wait for what the worker does on its own, like delivering a return. */
const SETTLED = { timeout: 4_000 };

type Mode =
  /** botd answers. */
  | "answer"
  /** The connection drops before botd reads the request. */
  | "lose-request"
  /** botd types, then the connection drops before its answer arrives. */
  | "lose-answer"
  /** botd is stopping: it refuses before acting with the masked 500 the worker can't tell apart. */
  | "stopping";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function pathOf(procedure: { "~orpc": { route: { path?: string } } }): string {
  return procedure["~orpc"].route.path!;
}

async function computerStandIn(screenId: string) {
  const state = {
    mode: "answer" as Mode,
    /** A computer deployed before `code-outcome` answers it with 404. */
    answersOutcome: true,
    holder: null as typeof CODE_HOLDER | null,
    /** Code entries botd got or refused, like `CodeScreens`: never typed twice. */
    outcomes: new Map<string, CodeEntryResult>(),
    typed: 0,
  };
  const typeCode = (operationId: string): CodeEntryResult => {
    if (state.outcomes.has(operationId))
      return { status: "unknown", reason: "Check the screen before sending again." };
    if (state.holder) {
      const refused = { status: "failed" as const, reason: "The screen is already in use by you." };
      state.outcomes.set(operationId, refused);
      return refused;
    }
    state.holder = CODE_HOLDER;
    state.typed++;
    const answer = { status: "needs_owner" as const, reason: TYPED, previous: null };
    state.outcomes.set(operationId, answer);
    return answer;
  };
  const codeOutcome = (operationId: string): CodeEntryResult => {
    const known = state.outcomes.get(operationId);
    if (known) return known;
    const answer: CodeEntryResult = state.holder
      ? { status: "unknown", reason: "Check the screen before sending again." }
      : { status: "failed", reason: NEVER_GOT };
    state.outcomes.set(operationId, answer);
    return answer;
  };
  const health = () => ({
    ...HEALTH,
    screens: [{ id: screenId, state: "running", browser: "running", lease: state.holder }],
  });
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = raw ? (JSON.parse(raw) as { operationId?: string }) : {};
    const path = new URL(request.url!, "http://botd").pathname;
    if (request.method === "GET" && path === "/health") return json(response, 200, health());
    if (path === pathOf(botdContract.computer.codeContext))
      return json(response, 200, { site: "example.com" });
    if (path === pathOf(botdContract.leases.release)) {
      state.holder = null;
      return json(response, 200, { released: true });
    }
    if (path === pathOf(botdContract.computer.type)) {
      if (state.mode === "lose-request") return request.socket.destroy();
      if (state.mode === "stopping")
        return json(response, 500, {
          error: "The outcome is unknown. Check the screen.",
          code: "INTERNAL_SERVER_ERROR",
        });
      const answer = typeCode(body.operationId!);
      if (state.mode === "lose-answer") return request.socket.destroy();
      return json(response, 200, answer);
    }
    if (path === pathOf(botdContract.computer.codeOutcome) && state.answersOutcome)
      return json(response, 200, codeOutcome(body.operationId!));
    json(response, 404, { error: "not found", code: "NOT_FOUND" });
  });
  const sockets = new WebSocketServer({ noServer: true });
  const connected: WebSocket[] = [];
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (ws) => {
      connected.push(ws);
      ws.send(JSON.stringify({ type: "lease", screenId, holder: state.holder }));
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
describe.skipIf(!url)("a Type-the-code answer the worker never got", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  beforeAll(async () => {
    await database.create();
  });
  afterAll(async () => {
    await database.drop();
  });

  /** A teammate's run asked you to enter a code on its free screen. */
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
    const [requester] = await db
      .insert(runs)
      .values({
        chatId: chat!.id,
        teammateId: screenId,
        trigger: "user",
        prompt: "Sign in to the airline",
        status: "completed",
      })
      .returning();
    const [request] = await db
      .insert(screenTakeovers)
      .values({
        screenId,
        status: "requested",
        requestedByRunId: requester!.id,
        requestedByTeammateId: screenId,
        reason: "Enter the code the airline sent",
        itemId: randomUUID(),
      })
      .returning();
    const botd = await computerStandIn(screenId);
    const computer = new ComputerClient(botd.url, "secret", logger());
    cleanup.push(() => computer.stop());
    computer.start();
    await vi.waitFor(() => expect(computer.online).toBe(true), SETTLED);
    const ctx = {
      db,
      pool,
      computer,
      events: new EventEmitter(),
      log: logger(),
    } as unknown as Context;
    const takeovers = new TakeoverService(ctx, new SessionRegistry());
    const operations = new ScreenOperationService(ctx, takeovers);
    const input = () => ({
      takeoverId: request!.id,
      operationId: randomUUID(),
      expectedSite: "example.com",
      pressEnter: false,
      text: "582913",
    });
    const rows = () =>
      db.select().from(screenTakeovers).where(eq(screenTakeovers.screenId, screenId));
    const deliveries = () =>
      db
        .select()
        .from(takeoverDeliveries)
        .innerJoin(screenTakeovers, eq(screenTakeovers.id, takeoverDeliveries.id))
        .where(eq(screenTakeovers.screenId, screenId));
    const continuations = () =>
      db
        .select()
        .from(runs)
        .where(and(eq(runs.parentRunId, requester!.id), eq(runs.trigger, "hand_back")));
    return {
      screenId,
      request: request!,
      botd,
      takeovers,
      operations,
      input,
      rows,
      deliveries,
      continuations,
    };
  }

  it.each(["lose-request", "stopping"] as const)(
    "a code botd never got (%s) leaves the request open, never handed back, and can be sent again",
    async (mode) => {
      const { botd, takeovers, operations, input, rows, deliveries } = await setUp();
      botd.state.mode = mode;
      expect(await operations.type(input())).toMatchObject({ status: "failed", reason: NEVER_GOT });
      expect(botd.state.typed).toBe(0);
      expect(botd.state.holder).toBeNull();
      // The reconciler finds nothing to end: no hand-back reaches the teammate.
      await takeovers.reconcile();
      expect(await rows()).toMatchObject([{ status: "requested" }]);
      expect(await deliveries()).toEqual([]);
      // You send it again, and this time botd answers.
      botd.state.mode = "answer";
      expect(await operations.type(input())).toMatchObject({ status: "needs_owner" });
      expect(botd.state.typed).toBe(1);
      expect(await rows()).toMatchObject([{ status: "active" }]);
    },
  );

  it("a lost answer settles as botd answered, and handing back answers the request", async () => {
    const { screenId, botd, takeovers, operations, input, rows, continuations } = await setUp();
    botd.state.mode = "lose-answer";
    const entry = input();
    expect(await operations.type(entry)).toMatchObject({ status: "needs_owner", reason: TYPED });
    expect(botd.state.typed).toBe(1);
    expect(await rows()).toMatchObject([{ status: "active" }]);
    await takeovers.handBack(screenId, null, true);
    expect(botd.state.holder).toBeNull();
    expect(await rows()).toMatchObject([{ status: "ended", endReason: "handed_back" }]);
    await vi.waitFor(async () => expect(await continuations()).toHaveLength(1), SETTLED);
    await takeovers.reconcile();
    expect(await operations.get(entry.operationId)).toMatchObject({ status: "handed_back" });
  });

  it("a code entry the worker restarted during is taken over by the reconciler, so handing back answers the request", async () => {
    const { screenId, request, botd, takeovers, operations, rows, continuations } = await setUp();
    // botd typed and holds the screen for you; the worker died before it heard back.
    const operationId = randomUUID();
    botd.state.holder = CODE_HOLDER;
    await db
      .insert(screenOperations)
      .values({ id: operationId, takeoverId: request.id, screenId, status: "typing" });
    await operations.recover();
    await takeovers.reconcile();
    expect(await rows()).toMatchObject([{ id: request.id, status: "active" }]);
    await takeovers.handBack(screenId, null, true);
    expect(await rows()).toMatchObject([{ status: "ended", endReason: "handed_back" }]);
    await vi.waitFor(async () => expect(await continuations()).toHaveLength(1), SETTLED);
    expect((await continuations())[0]!.prompt).toContain("Enter the code the airline sent");
    await takeovers.reconcile();
    expect(await operations.get(operationId)).toMatchObject({ status: "handed_back" });
  });

  it("handing back a screen the worker restarted during, before the reconciler runs, keeps your note and answers the request once", async () => {
    const { screenId, request, botd, takeovers, operations, rows, deliveries, continuations } =
      await setUp();
    const operationId = randomUUID();
    botd.state.holder = CODE_HOLDER;
    await db
      .insert(screenOperations)
      .values({ id: operationId, takeoverId: request.id, screenId, status: "typing" });
    await operations.recover();
    expect(await rows()).toMatchObject([{ id: request.id, status: "requested" }]);
    // You clear the code and hand back before the reconciler's first pass.
    await takeovers.handBack(screenId, "Signed in, carry on", true);
    expect(botd.state.holder).toBeNull();
    expect(await rows()).toMatchObject([
      { id: request.id, status: "ended", endReason: "handed_back", note: "Signed in, carry on" },
    ]);
    expect(await operations.get(operationId)).toMatchObject({ status: "handed_back" });
    await vi.waitFor(async () => expect(await continuations()).toHaveLength(1), SETTLED);
    expect((await continuations())[0]!.prompt).toContain("Signed in, carry on");
    // A later pass finds nothing left to do and never answers twice.
    await takeovers.reconcile();
    expect(await deliveries()).toHaveLength(1);
    expect(await continuations()).toHaveLength(1);
  });

  it("with a computer that can't say what became of it, records a takeover only if botd holds the screen", async () => {
    const { botd, takeovers, operations, input, rows, deliveries } = await setUp();
    botd.state.answersOutcome = false;
    botd.state.mode = "lose-request";
    expect(await operations.type(input())).toMatchObject({ status: "unknown" });
    await takeovers.reconcile();
    expect(await rows()).toMatchObject([{ status: "requested" }]);
    expect(await deliveries()).toEqual([]);
    botd.state.mode = "lose-answer";
    expect(await operations.type(input())).toMatchObject({ status: "unknown" });
    expect(botd.state.holder).toEqual(CODE_HOLDER);
    expect(await rows()).toMatchObject([{ status: "active" }]);
  });
});
