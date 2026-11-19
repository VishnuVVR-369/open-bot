import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CodexManager } from "./client";
import { ComputerLifecycle } from "../computer/lifecycle";
import type { ComputerClient } from "../computer/client";
import type { Logger } from "../logger";
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

describe("Codex connecting in the background", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("logs a sign-in that fails once connected, since status doesn't show it", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    // Codex answers every request, so connecting succeeds.
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
      }),
    );
    cleanup.push(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    const computer = {
      wsUrl: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } as unknown as ComputerClient;
    const log = logger();
    const codex = new CodexManager(
      computer,
      "/unused",
      "codex",
      async () => {
        throw new Error("settings unreadable");
      },
      log as unknown as Logger,
    );
    cleanup.push(() => codex.stop());
    codex.start();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith("couldn't get Codex ready", {
        error: "settings unreadable",
      }),
    );
    expect(codex.status.error).toBeNull();
  });

  it("leaves a device sign-in the owner still has to do to the status", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    // Codex is up, with no account signed in.
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === undefined) return;
        const result = message.method === "account/read" ? { account: null } : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      }),
    );
    cleanup.push(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    const computer = {
      wsUrl: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } as unknown as ComputerClient;
    const log = logger();
    const codex = new CodexManager(
      computer,
      "/unused",
      "codex",
      async () => "device",
      log as unknown as Logger,
    );
    cleanup.push(() => codex.stop());
    codex.start();
    await vi.waitFor(() => expect(codex.status.error).toMatch(/not signed in/));
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a new failure even while status still shows an older one", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    // Codex is up, with no account signed in.
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === undefined) return;
        const result = message.method === "account/read" ? { account: null } : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      }),
    );
    cleanup.push(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    const computer = {
      wsUrl: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } as unknown as ComputerClient;
    const log = logger();
    let settingsReadable = true;
    const codex = new CodexManager(
      computer,
      "/unused",
      "codex",
      async () => {
        if (settingsReadable) return "device";
        throw new Error("settings unreadable");
      },
      log as unknown as Logger,
    );
    cleanup.push(() => codex.stop());
    codex.start();
    await vi.waitFor(() => expect(codex.status.error).toMatch(/not signed in/));
    // The computer's events socket reconnects and starts Codex again, on the same open socket.
    settingsReadable = false;
    codex.start();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith("couldn't get Codex ready", {
        error: "settings unreadable",
      }),
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("leaves an unreachable computer to the status and its retry", async () => {
    const computer = { wsUrl: () => "ws://127.0.0.1:9" } as unknown as ComputerClient;
    const log = logger();
    const codex = new CodexManager(
      computer,
      "/unused",
      "codex",
      async () => "device",
      log as unknown as Logger,
    );
    cleanup.push(() => codex.stop());
    codex.start();
    await vi.waitFor(() => expect(codex.status.error).toMatch(/Can't reach Codex/));
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn).not.toHaveBeenCalled();
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

describe("signing in to Codex with this Mac's login", () => {
  /** An app-server stand-in that signs in on `account/login/start` and counts the requests. */
  async function standInCodex() {
    const requests: string[] = [];
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    server.on("connection", (socket) => {
      let signedIn = false;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === undefined) return;
        requests.push(message.method);
        if (message.method === "account/login/start") signedIn = true;
        const result =
          message.method === "account/read"
            ? {
                account: signedIn
                  ? { type: "chatgpt", email: "owner@example.test", planType: "plus" }
                  : null,
              }
            : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
    cleanup.push(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    const computer = {
      wsUrl: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } as unknown as ComputerClient;
    return { computer, requests };
  }

  /** A ChatGPT login file, with an access token that is good for another month. */
  async function hostLogin() {
    const dir = await mkdtemp(path.join(tmpdir(), "openbot-codex-login-"));
    cleanup.push(() => void rm(dir, { recursive: true, force: true }));
    const claims = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86_400 }),
    ).toString("base64url");
    const file = path.join(dir, "auth.json");
    await writeFile(
      file,
      JSON.stringify({ tokens: { access_token: `e30.${claims}.sig`, account_id: "acct-1" } }),
    );
    return file;
  }

  const quiet = () =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }) as unknown as Logger;

  it("logs in once per connection, though connecting wakes another caller mid sign-in", async () => {
    const { computer, requests } = await standInCodex();
    const codex = new CodexManager(
      computer,
      await hostLogin(),
      "codex",
      async () => "host",
      quiet(),
    );
    cleanup.push(() => codex.stop());
    // As the worker writes the skills (through ready()) as soon as status says it's connected.
    const woken: Promise<unknown>[] = [];
    codex.on("status", (status) => {
      if (status.connected && woken.length === 0) woken.push(codex.ready());
    });

    const client = await codex.ready();

    await expect(woken[0]).resolves.toBe(client);
    expect(requests.filter((method) => method === "account/login/start")).toHaveLength(1);
    expect(codex.status.account).toEqual({
      type: "chatgpt",
      email: "owner@example.test",
      planType: "plus",
    });
  });

  it("logs in again when you ask, as after switching where the login comes from", async () => {
    const { computer, requests } = await standInCodex();
    const codex = new CodexManager(
      computer,
      await hostLogin(),
      "codex",
      async () => "host",
      quiet(),
    );
    cleanup.push(() => codex.stop());
    await codex.ready();

    await codex.reauthenticate();

    expect(requests.filter((method) => method === "account/login/start")).toHaveLength(2);
  });
});
