import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CodexManager } from "./codex";
import { ComputerLifecycle } from "./computer-lifecycle";
import type { ComputerClient } from "./computer";
import type { Logger } from "./logger";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
describe("Codex intentional idle", () => {
  it("keeps cached auth/rate limits without status polling renewing demand, then clears auth on logout", async () => {
    const requests: string[] = [];
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    let loggedOut = false;
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === undefined) return;
        requests.push(message.method);
        const result =
          message.method === "account/read"
            ? { account: loggedOut ? null : { type: "apiKey" } }
            : message.method === "account/rateLimits/read"
              ? {
                  rateLimits: {
                    limitId: "test",
                    primary: null,
                    secondary: null,
                    credits: null,
                    planType: null,
                  },
                }
              : {};
        if (message.method === "account/logout") loggedOut = true;
        socket.send(JSON.stringify({ id: message.id, result }));
      }),
    );
    const computer = {
      wsUrl: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } as unknown as ComputerClient;
    const codex = new CodexManager(computer, "/unused", "codex", async () => "device", {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger);
    const lifecycle = new ComputerLifecycle(true, {
      wake: async () => true,
      restore: async () => {
        await codex.resume();
        await codex.rateLimits(true);
      },
      quiesce: async () => {
        codex.setIdleIntent(true);
        const sockets = [...server.clients];
        for (const socket of sockets) socket.close();
        await Promise.all(sockets.map((socket) => once(socket, "close")));
        return true;
      },
      pause: () => codex.pause(),
      renew: async () => {},
      busy: () => false,
      changed: vi.fn(),
      warn: vi.fn(),
    });
    codex.lifecycle = lifecycle;
    cleanup.push(() => {
      lifecycle.stop();
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    await lifecycle.run("file", async () => {
      await codex.ready();
    });
    const before = lifecycle.status.changedAt;
    const rateRequests = requests.filter((m) => m === "account/rateLimits/read").length;
    expect(await codex.rateLimits()).not.toBeNull();
    expect(lifecycle.status.changedAt).toBe(before);
    expect(requests.filter((m) => m === "account/rateLimits/read")).toHaveLength(rateRequests);
    codex.markLoaded("saved-thread");
    await lifecycle.idle();
    expect(codex.status).toMatchObject({
      connected: false,
      stale: true,
      account: { type: "apiKey" },
    });
    expect(codex.isLoaded("saved-thread")).toBe(false);
    const count = requests.length;
    await codex.rateLimits();
    expect(requests).toHaveLength(count);
    await codex.logout();
    expect(codex.status.account).toBeNull();
    expect(await codex.rateLimits()).toBeNull();
  });
});

it("returns failed awake reconnects to lifecycle admission instead of polling a stopped agent", async () => {
  const computer = { wsUrl: () => "ws://127.0.0.1:9" } as unknown as ComputerClient;
  const codex = new CodexManager(computer, "/unused", "codex", async () => "device", {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger);
  const lost = vi.fn(() => codex.pause());
  codex.lifecycle = {
    enabled: true,
    inScope: false,
    run: async (_reason: string, work: () => Promise<unknown>) => work(),
    connectionLost: lost,
  } as unknown as ComputerLifecycle;
  await expect(codex.ready()).rejects.toThrow();
  expect(lost).toHaveBeenCalledTimes(1);
  codex.stop();
});
