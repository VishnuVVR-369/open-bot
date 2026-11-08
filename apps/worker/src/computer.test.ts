import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ComputerHealth } from "@open-bot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { BotdError, ComputerClient } from "./computer";
import type { ComputerLifecycle } from "./computer-lifecycle";
import type { Logger } from "./logger";

// `ComputerClient` against a stand-in botd: what it sends, and what it does with what comes back.

const HEALTH: ComputerHealth = {
  ok: true,
  bootedAt: "2026-11-08T00:00:00.000Z",
  agent: "running",
  screens: [],
  egress: { mode: "off", agentOnline: false, tunnelConnected: false },
};
const SCREEN = "6f1c2a4e-1b2c-4d5e-8f90-123456789abc";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Answer = { status?: number; body: unknown };

/** A botd that answers each `METHOD /path` from `routes`, and streams `/events` to `onEvents`. */
async function standIn(routes: Record<string, Answer | ((body: unknown) => Answer)>) {
  const requests: { route: string; body: unknown; authorization?: string }[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const route = `${request.method} ${new URL(request.url!, "http://botd").pathname}`;
    requests.push({ route, body, authorization: request.headers.authorization });
    const entry = routes[route];
    const answer =
      typeof entry === "function"
        ? entry(body)
        : (entry ?? { status: 404, body: { error: "not found" } });
    response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  const sockets = new WebSocketServer({ noServer: true });
  const connected: WebSocket[] = [];
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (ws) => connected.push(ws)),
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, connected };
}

function logger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

async function rejection(promise: Promise<unknown>): Promise<BotdError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BotdError);
  return error as BotdError;
}

describe("ComputerClient", () => {
  it("sends the token and the contract's body, and returns the validated answer", async () => {
    const botd = await standIn({
      "POST /lease/user/release": { body: { released: true, extra: "dropped" } },
    });
    const computer = new ComputerClient(botd.url, "secret", logger());
    expect(await computer.releaseByUser(SCREEN, "user_idle")).toEqual({ released: true });
    expect(botd.requests).toEqual([
      {
        route: "POST /lease/user/release",
        body: { screenId: SCREEN, reason: "user_idle", clearCode: false },
        authorization: "Bearer secret",
      },
    ]);
  });

  it("keeps botd's status and message, including `{ error }` from a botd older than the contract", async () => {
    const botd = await standIn({
      "POST /lifecycle/quiesce": { status: 409, body: { error: 'Computer busy: {"demand":1}' } },
      "POST /lease/user/take": {
        status: 409,
        body: { error: "Code entry is in progress.", code: "CONFLICT" },
      },
    });
    const computer = new ComputerClient(botd.url, "secret", logger());
    const busy = await rejection(computer.botd.lifecycle.quiesce({ owner: "worker" }));
    expect(busy.status).toBe(409);
    expect(busy.path).toBe("/lifecycle/quiesce");
    expect(busy.detail).toBe('Computer busy: {"demand":1}');
    const taking = await rejection(computer.takeByUser(SCREEN));
    expect(taking.status).toBe(409);
    expect(taking.detail).toBe("Code entry is in progress.");
    // A botd without the lifecycle is a 404, which the wake treats as "no lifecycle".
    expect((await rejection(computer.botd.lifecycle.capabilities())).status).toBe(404);
  });

  it("refuses an answer that doesn't fit the contract", async () => {
    const botd = await standIn({
      "POST /lease/run/release": { body: { released: "yes" } },
      "POST /screens/start": { body: { id: SCREEN, state: "running", browser: "running" } },
    });
    const computer = new ComputerClient(botd.url, "secret", logger());
    const release = await rejection(computer.releaseRun("run-1"));
    expect(release.status).toBe(502);
    expect(release.detail).toContain("released");
    const started = await rejection(computer.startScreen(SCREEN));
    expect(started.detail).toContain("lease");
  });

  it("wakes the computer for work on it, but never for a status read or a lifecycle call", async () => {
    const botd = await standIn({
      "POST /lease/user/touch": { body: { holder: null } },
      "GET /health": { body: HEALTH },
      "GET /healthz": { body: { ok: true } },
      "POST /lifecycle/lease": { body: { version: 1, enabled: true, phase: "awake" } },
    });
    const computer = new ComputerClient(botd.url, "secret", logger());
    let inScope = false;
    const run = vi.fn(async (_reason: string, work: () => Promise<unknown>) => {
      inScope = true;
      try {
        return await work();
      } finally {
        inScope = false;
      }
    });
    computer.lifecycle = {
      enabled: true,
      get inScope() {
        return inScope;
      },
      signal: undefined,
      run,
    } as unknown as ComputerLifecycle;
    await computer.touchUser(SCREEN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("/lease/user/touch");
    await computer.botd.healthz();
    await computer.botd.lifecycle.lease({ owner: "worker", demand: 1 });
    await computer.botd.health();
    expect(run).toHaveBeenCalledTimes(1);
    // While the lifecycle has the computer awake, a status read is answered by botd.
    inScope = true;
    expect(await computer.fetchHealth()).toEqual(HEALTH);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips an event that doesn't fit the contract and keeps applying the ones that do", async () => {
    const botd = await standIn({});
    const log = logger();
    const computer = new ComputerClient(botd.url, "secret", log);
    cleanup.push(() => computer.stop());
    const leases: unknown[] = [];
    computer.on("lease", (screenId, holder) => leases.push({ screenId, holder }));
    computer.start();
    await vi.waitFor(() => expect(botd.connected).toHaveLength(1));
    const socket = botd.connected[0]!;
    const healthy = once(computer, "health");
    socket.send("not json");
    // A type that can't become a string must not throw out of the socket's message handler.
    socket.send('{"type":{"toString":null}}');
    socket.send(JSON.stringify({ type: "lease", screenId: SCREEN, holder: { kind: "robot" } }));
    socket.send(JSON.stringify({ type: "health", health: { ...HEALTH, screens: "none" } }));
    socket.send(JSON.stringify({ type: "health", health: HEALTH }));
    await healthy;
    expect(computer.health).toEqual(HEALTH);
    expect(computer.online).toBe(true);
    expect(leases).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(4);
    const since = "2026-11-08T00:00:00.000Z";
    const leased = once(computer, "lease");
    socket.send(
      JSON.stringify({
        type: "lease",
        screenId: SCREEN,
        holder: { kind: "user", since, lastInputAt: since },
        reason: "acquired",
      }),
    );
    await leased;
    expect(computer.lease(SCREEN)).toEqual({ kind: "user", since, lastInputAt: since });
  });
});
