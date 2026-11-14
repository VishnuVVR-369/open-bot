import { once, EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ComputeLifecycle } from "./lifecycle";
import { createServer } from "./server";
import type { ScreenManager } from "./screen-manager";
import type { Screen } from "./screens";
import type { EgressRouter } from "@open-bot/egress/router";
import type { PageChecker } from "./pages";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(codexUrl: string) {
  const stop = vi.fn(async () => {});
  const lifecycle = new ComputeLifecycle(true, {
    start: async () => {},
    stop,
    busy: async () => false,
  });
  lifecycle.lease("worker", 0);
  await lifecycle.ensure("worker");
  const screens = Object.assign(new EventEmitter(), { list: () => [] }) as unknown as ScreenManager;
  const { server } = createServer({
    token: "test-token",
    screens,
    lifecycle,
    codexUrl,
    egress: { noteDemand: () => {} } as unknown as EgressRouter,
    pages: {} as PageChecker,
    health: () => ({
      ok: true,
      bootedAt: "test",
      agent: "running",
      screens: [],
      egress: {
        mode: "require",
        agentOnline: false,
        tunnelConnected: false,
        configured: false,
        held: 0,
        refusedRecently: 0,
      },
    }),
    log: () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    lifecycle,
    stop,
    screens,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/codex?token=test-token`,
  };
}
describe("Codex bridge activity tracking", () => {
  it("does not retain unsent initialization attempts when Codex is still stopped during a rollout", async () => {
    const { lifecycle, stop, url } = await fixture("ws://127.0.0.1:9");
    const client = new WebSocket(url);
    client.on("error", () => {});
    client.on("open", () =>
      client.send(JSON.stringify({ id: 1, method: "initialize", params: {} })),
    );
    await once(client, "close");
    await lifecycle.quiesce("worker");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("matches binary JSON responses to text JSON requests", async () => {
    const upstream = new WebSocketServer({ port: 0 });
    await once(upstream, "listening");
    upstream.on("connection", (socket) =>
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        socket.send(JSON.stringify({ id: message.id, result: {} }), { binary: true });
      }),
    );
    cleanup.push(async () => {
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const { lifecycle, stop, url } = await fixture(
      `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    );
    const client = new WebSocket(url);
    await once(client, "open");
    const reply = once(client, "message");
    client.send(JSON.stringify({ id: 1, method: "account/read", params: {} }));
    await reply;
    client.close();
    await once(client, "close");
    await lifecycle.quiesce("worker");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

it("never performs a run action cancelled while waiting for screen admission", async () => {
  const { lifecycle, stop, screens, url } = await fixture("ws://127.0.0.1:9");
  const perform = vi.fn(async () => {});
  const screen = {
    lease: { acquireForRun: async () => "ok", holder: null },
    desktop: {
      perform,
      screenshot: async () => Buffer.alloc(0),
      cursor: async () => ({ x: 0, y: 0 }),
    },
    takeBlocked: () => [],
  } as unknown as Screen;
  let admit!: () => void;
  let cancellation: AbortSignal | undefined;
  screens.ensure = vi.fn((_id: string, signal?: AbortSignal) => {
    cancellation = signal;
    return new Promise<Screen>((resolve) => {
      admit = () => resolve(screen);
    });
  });
  screens.touch = () => {};
  const controller = new AbortController();
  const endpoint = new URL(url);
  endpoint.protocol = "http:";
  endpoint.pathname = "/computer/action";
  endpoint.search = "";
  const pending = fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({
      run: { runId: randomUUID(), botId: randomUUID(), botName: "Test" },
      action: { action: "key", keys: "Return" },
    }),
    signal: controller.signal,
  });
  const cancelled = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(screens.ensure).toHaveBeenCalled());
  controller.abort();
  await cancelled;
  await vi.waitFor(() => expect(cancellation?.aborted).toBe(true));
  admit();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(perform).not.toHaveBeenCalled();
  await lifecycle.quiesce("worker");
  expect(stop).toHaveBeenCalledTimes(1);
});

it("answers 409 when work blocks sleep, and 500 when stopping itself fails", async () => {
  const { lifecycle, stop, url } = await fixture("ws://127.0.0.1:9");
  const endpoint = new URL(url);
  endpoint.protocol = "http:";
  endpoint.pathname = "/lifecycle/quiesce";
  endpoint.search = "";
  const quiesce = () =>
    fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ owner: "worker" }),
    });
  lifecycle.lease("worker", 1);
  const busy = await quiesce();
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { error: string }).error).toContain('"demand":1');
  lifecycle.lease("worker", 0);
  stop.mockRejectedValueOnce(new Error("Timed out waiting for the bot user's processes to exit"));
  expect((await quiesce()).status).toBe(500);
  expect((await quiesce()).status).toBe(200);
  expect(stop).toHaveBeenCalledTimes(2);
});
