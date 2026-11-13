import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net, { type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_GONE, decodeFrame, encodeFrame, FrameType, type ControlMessage } from "./frames";
import type { EgressMode } from "@open-bot/domain";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { EgressRouter, type EgressLimits } from "./router";

const LIMITS: EgressLimits = { deadlineMs: 900, openReserveMs: 300, maxHeld: 256 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function portOf(server: net.Server | WebSocketServer): Promise<number> {
  return new Promise((resolve) => {
    const done = () => resolve((server.address() as AddressInfo).port);
    if (server instanceof net.Server && server.listening) done();
    else server.once("listening", done);
  });
}

/** A local server that stands in for any destination a direct connection reaches. */
async function destination(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return portOf(server);
}

/** SOCKS5 CONNECT; resolves with the reply code and how long it took. */
function socksConnect(proxyPort: number, port: number): Promise<{ reply: number; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => void socket.destroy());
    let stage = 0;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        buffer = buffer.subarray(2);
        stage = 1;
        socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, port >> 8, port & 0xff]));
      }
      if (stage === 1 && buffer.length >= 10) {
        stage = 2;
        resolve({ reply: buffer[1]!, ms: Date.now() - started });
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (stage < 2) reject(new Error("closed without a reply"));
    });
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

async function setup(
  options: { lastMode?: EgressMode; leased?: string[]; limits?: Partial<EgressLimits> } = {},
) {
  const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "botd-egress-")), "egress.json");
  if (options.lastMode) writeFileSync(stateFile, JSON.stringify({ mode: options.lastMode }));
  const leased = options.leased ?? [];
  const router = new EgressRouter({
    log: () => {},
    onChange: () => {},
    stateFile,
    leasedScreens: () => leased,
    limits: { ...LIMITS, ...options.limits },
  });
  const socks = router.listen(0);
  const socksPort = await portOf(socks);

  // The worker's relay, played by the test: botd accepts its tunnel connection.
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => router.attachTunnel(socket));
  const serverPort = await portOf(server);
  cleanups.push(async () => {
    socks.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function relay() {
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}`);
    const texts: ControlMessage[] = [];
    const opens: number[] = [];
    socket.on("message", (data, isBinary) => {
      if (!isBinary) texts.push(JSON.parse(data.toString()) as ControlMessage);
      else {
        const frame = decodeFrame(data as Buffer);
        if (frame.type === FrameType.Open) opens.push(frame.streamId);
      }
    });
    await new Promise((resolve) => socket.once("open", resolve));
    cleanups.push(() => socket.terminate());
    const config = (message: Omit<Extract<ControlMessage, { type: "config" }>, "type">) =>
      socket.send(JSON.stringify({ type: "config", ...message }));
    return { socket, texts, opens, config };
  }

  return {
    router,
    stateFile,
    relay,
    connect: (port: number) => socksConnect(socksPort, port),
  };
}

const SUCCEEDED = 0;
const NOT_ALLOWED = 2;
const HOST_UNREACHABLE = 4;

describe("botd egress router", () => {
  it("before the first config, waits, then refuses when the last mode was require", async () => {
    const env = await setup({ lastMode: "require" });
    const result = await env.connect(await destination());
    expect(result.reply).toBe(NOT_ALLOWED);
    // It waited for the worker until the open reserve, not longer.
    expect(result.ms).toBeGreaterThanOrEqual(LIMITS.deadlineMs - LIMITS.openReserveMs - 20);
    expect(result.ms).toBeLessThan(LIMITS.deadlineMs);
  });

  it("before the first config, goes direct after the wait when the last mode was prefer", async () => {
    const env = await setup({ lastMode: "prefer" });
    expect((await env.connect(await destination())).reply).toBe(SUCCEEDED);
  });

  it("refuses without any remembered mode", async () => {
    const env = await setup();
    expect((await env.connect(await destination())).reply).toBe(NOT_ALLOWED);
  });

  it("goes on at once when the config arrives during the wait, and remembers its mode", async () => {
    const env = await setup({ lastMode: "require", limits: { deadlineMs: 5_000 } });
    const pending = env.connect(await destination());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const relay = await env.relay();
    relay.config({ mode: "prefer", agentOnline: false });
    const result = await pending;
    expect(result.reply).toBe(SUCCEEDED);
    expect(result.ms).toBeLessThan(1_000);
    await until(
      () => readFileSync(env.stateFile, "utf8") === JSON.stringify({ mode: "prefer" }),
      "the saved mode",
    );
  });

  it("tells the relay about every screen that wants browsing when the tunnel connects", async () => {
    const env = await setup({ leased: ["bot-leased"] });
    env.router.noteDemand("bot-starting");
    const relay = await env.relay();
    await until(() => relay.texts.length === 2, "the demand messages");
    expect(relay.texts).toEqual(
      expect.arrayContaining([
        { type: "demand", screenId: "bot-starting" },
        { type: "demand", screenId: "bot-leased" },
      ]),
    );
    // Again on a new tunnel, as after a worker restart.
    relay.socket.terminate();
    const again = await env.relay();
    await until(() => again.texts.length === 2, "the demand messages again");
  });

  it("holds on local demand while a phone could be woken, and goes through it once it connects", async () => {
    const env = await setup({ limits: { deadlineMs: 5_000, openReserveMs: 1_000 } });
    const relay = await env.relay();
    relay.config({ mode: "require", agentOnline: false, wakeable: true });
    await until(() => env.router.state.configured, "the config");
    env.router.noteDemand("bot-1");
    const pending = env.connect(await destination());
    await until(() => env.router.state.held === 1, "the hold");
    relay.config({ mode: "require", agentOnline: true, wakeable: true });
    await until(() => relay.opens.length === 1, "the open");
    relay.socket.send(encodeFrame(FrameType.OpenOk, relay.opens[0]!));
    expect((await pending).reply).toBe(SUCCEEDED);
    expect(env.router.state.held).toBe(0);
  });

  it("doesn't hold without demand, even when a phone could be woken", async () => {
    const env = await setup();
    const relay = await env.relay();
    relay.config({ mode: "require", agentOnline: false, wakeable: true });
    await until(() => env.router.state.configured, "the config");
    const result = await env.connect(await destination());
    expect(result.reply).toBe(NOT_ALLOWED);
    expect(result.ms).toBeLessThan(200);
    expect(env.router.state.refusedRecently).toBe(1);
  });

  it("holds for the worker's holdMs without local demand", async () => {
    const env = await setup({ limits: { deadlineMs: 5_000, openReserveMs: 1_000 } });
    const relay = await env.relay();
    relay.config({ mode: "require", agentOnline: false, holdMs: 300 });
    await until(() => env.router.state.configured, "the config");
    const result = await env.connect(await destination());
    expect(result.reply).toBe(NOT_ALLOWED);
    expect(result.ms).toBeGreaterThanOrEqual(250);
    expect(result.ms).toBeLessThan(1_000);
  });

  it("keeps one deadline across the hold and a slow open", async () => {
    const env = await setup({ limits: { deadlineMs: 900, openReserveMs: 300 } });
    const relay = await env.relay();
    relay.config({ mode: "require", agentOnline: false, wakeable: true });
    await until(() => env.router.state.configured, "the config");
    env.router.noteDemand("bot-1");
    const pending = env.connect(await destination());
    await until(() => env.router.state.held === 1, "the hold");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A device arrives late in the hold, and never answers the open.
    relay.config({ mode: "require", agentOnline: true, wakeable: true });
    const result = await pending;
    expect(result.reply).toBe(HOST_UNREACHABLE);
    expect(result.ms).toBeGreaterThanOrEqual(LIMITS.deadlineMs - 20);
    expect(result.ms).toBeLessThan(LIMITS.deadlineMs + 300);
  });

  it("routes again when the device carrying an open goes away", async () => {
    const env = await setup({ limits: { deadlineMs: 5_000, openReserveMs: 1_000 } });
    const relay = await env.relay();
    relay.config({ mode: "prefer", agentOnline: true });
    const pending = env.connect(await destination());
    await until(() => relay.opens.length === 1, "the open");
    // As the relay does: the fresh config first, then the failure.
    relay.config({ mode: "prefer", agentOnline: false });
    relay.socket.send(encodeFrame(FrameType.OpenFail, relay.opens[0]!, AGENT_GONE));
    expect((await pending).reply).toBe(SUCCEEDED);
  });

  it("doesn't hold more than its limit at once", async () => {
    const env = await setup({ limits: { deadlineMs: 5_000, openReserveMs: 1_000, maxHeld: 1 } });
    const relay = await env.relay();
    relay.config({ mode: "require", agentOnline: false, wakeable: true });
    await until(() => env.router.state.configured, "the config");
    env.router.noteDemand("bot-1");
    const port = await destination();
    const first = env.connect(port);
    await until(() => env.router.state.held === 1, "the first hold");
    const second = await env.connect(port);
    expect(second.reply).toBe(NOT_ALLOWED);
    expect(second.ms).toBeLessThan(200);
    relay.config({ mode: "require", agentOnline: false, wakeable: false });
    expect((await first).reply).toBe(NOT_ALLOWED);
  });

  it("doesn't reset streams on a config, only when the tunnel closes", async () => {
    const env = await setup({ limits: { deadlineMs: 5_000 } });
    const relay = await env.relay();
    relay.config({ mode: "prefer", agentOnline: true });
    const pending = env.connect(await destination());
    await until(() => relay.opens.length === 1, "the open");
    relay.socket.send(encodeFrame(FrameType.OpenOk, relay.opens[0]!));
    expect((await pending).reply).toBe(SUCCEEDED);
    const resets: number[] = [];
    relay.socket.on("message", (data, isBinary) => {
      if (isBinary && decodeFrame(data as Buffer).type === FrameType.Reset) resets.push(1);
    });
    relay.config({ mode: "prefer", agentOnline: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(resets).toEqual([]);
  });
});
