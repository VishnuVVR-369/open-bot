import { mkdtempSync } from "node:fs";
import net, { type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { egressStatusSchema } from "@open-bot/api";
import {
  AGENT_GONE,
  decodeFrame,
  EgressAgent,
  encodeFrame,
  FrameType,
  type AgentRole,
  type ControlMessage,
  type EgressMode,
  type PhoneMode,
} from "@open-bot/egress";
import type { EgressAgentClaim } from "@open-bot/shared/tokens";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
// The real computer side, as botd runs it.
import { EgressRouter } from "../../../botd/src/egress";
import { CLOSE_REVOKED, EgressRelay, type PairedPhone, type RelayStore } from "./relay";
import { WakeController } from "./wake";

const PHONE_ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";
const PHONE_2_ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a02";
const TIMINGS = { heartbeatMs: 100, drainMs: 400, reconcileMs: 150, computerRetryMs: 50 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listening(server: net.Server | WebSocketServer): Promise<number> {
  return new Promise((resolve) => {
    const address = () => (server.address() as AddressInfo).port;
    if (server instanceof WebSocketServer) server.once("listening", () => resolve(address()));
    else if (server.listening) resolve(address());
    else server.once("listening", () => resolve(address()));
  });
}

class FakeStore implements RelayStore {
  mode: EgressMode = "prefer";
  phoneMode: PhoneMode = "fallback";
  phones: PairedPhone[] = [];
  /** Delays the next pairing reads, to line up races. */
  readDelay: Promise<void> | null = null;

  async loadModes() {
    return { mode: this.mode, phoneMode: this.phoneMode };
  }
  async saveMode(mode: EgressMode) {
    this.mode = mode;
  }
  async savePhoneMode(mode: PhoneMode) {
    this.phoneMode = mode;
  }
  reads = 0;
  async pairedPhones() {
    this.reads += 1;
    const snapshot = this.phones.map((phone) => ({ ...phone }));
    if (this.readDelay) await this.readDelay;
    return snapshot;
  }
  pair(id: string, generation = 1) {
    this.phones = this.phones.filter((phone) => phone.id !== id);
    this.phones.push({
      id,
      name: `Phone ${id.slice(-2)}`,
      generation,
      pushToken: null,
      lastUsedAt: null,
    });
  }
  unpair(id: string) {
    this.phones = this.phones.filter((phone) => phone.id !== id);
  }
}

/** An echo server for the destination, which says which device's lookup reached it. */
async function echoServer(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
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
  return listening(server);
}

/** Connect through botd's SOCKS proxy; resolves with the socket, or rejects with the reply code. */
function socksConnect(proxyPort: number, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let stage = 0;
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        buffer = buffer.subarray(2);
        stage = 1;
        const name = Buffer.from(host);
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
            name,
            Buffer.from([port >> 8, port & 0xff]),
          ]),
        );
      }
      if (stage === 1 && buffer.length >= 10) {
        socket.off("data", onData);
        if (buffer[1] !== 0x00) {
          socket.destroy();
          reject(new Error(`SOCKS reply ${buffer[1]}`));
          return;
        }
        resolve(socket);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed")));
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

async function echo(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const onData = (chunk: Buffer) => {
      received += chunk.toString();
      if (received.length >= text.length) {
        socket.off("data", onData);
        resolve(received);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(text);
  });
}

async function setup(
  options: { mode?: EgressMode; phoneMode?: PhoneMode; timings?: Partial<typeof TIMINGS> } = {},
) {
  const store = new FakeStore();
  store.mode = options.mode ?? "prefer";
  store.phoneMode = options.phoneMode ?? "fallback";
  store.pair(PHONE_ID);
  store.phones[0]!.pushToken = "push-token";

  // botd: the SOCKS proxy and the tunnel endpoint the relay connects to.
  const router = new EgressRouter({
    log: () => {},
    onChange: () => {},
    stateFile: path.join(mkdtempSync(path.join(tmpdir(), "egress-")), "egress.json"),
    leasedScreens: () => [],
  });
  const socks = router.listen(0);
  const socksPort = await listening(socks);
  const tunnelServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const tunnelPort = await listening(tunnelServer);
  const tunnels: WebSocket[] = [];
  tunnelServer.on("connection", (socket) => {
    tunnels.push(socket);
    router.attachTunnel(socket);
  });

  // The worker: the relay, and the endpoint agents connect to, with the claim in the query
  // (the real one comes from a signed token).
  const relay = new EgressRelay({
    store,
    computerUrl: () => `ws://127.0.0.1:${tunnelPort}`,
    log: { info: () => {}, warn: () => {} },
    publish: () => {},
    timings: { ...TIMINGS, ...options.timings },
  });
  const agentServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const agentPort = await listening(agentServer);
  agentServer.on("connection", (socket, request) => {
    const claim = JSON.parse(
      new URL(request.url ?? "/", "http://x").searchParams.get("claim")!,
    ) as EgressAgentClaim;
    void relay.attachAgent(socket, claim);
  });
  // The wake controller, with pushes the test answers itself (see `onPush`).
  const pushes: string[] = [];
  let onPush: (stage: "wake" | "ask") => void = () => {};
  const wake = new WakeController({
    now: Date.now,
    relay,
    leasedScreens: () => [],
    pushConfigured: () => true,
    push: async (_phone, stage) => {
      pushes.push(stage);
      onPush(stage);
      return "sent";
    },
    phonesChanged: () => {},
    notifyUnanswered: async () => {},
    publish: () => {},
    log: { warn: () => {} },
    timings: { startGraceMs: 0 },
  });
  relay.setHooks({
    configExtras: () => wake.configExtras(),
    phoneStatus: (id) => wake.phoneStatus(id),
    waiting: () => wake.waiting(),
    onDemand: () => wake.demand(),
    onUnavailable: (id, reason, seq) => wake.unavailable(id, reason, seq),
    onAvailable: (id, seq) => wake.available(id, seq),
    onChange: () => wake.evaluate(),
  });
  await relay.start();
  await until(() => relay.computerConnected && router.state.configured, "the tunnel");

  cleanups.push(async () => {
    relay.stop();
    socks.close();
    for (const client of tunnelServer.clients) client.terminate();
    for (const client of agentServer.clients) client.terminate();
    await new Promise<void>((resolve) => tunnelServer.close(() => resolve()));
    await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  });

  const agentUrl = (claim: EgressAgentClaim) =>
    `ws://127.0.0.1:${agentPort}/?claim=${encodeURIComponent(JSON.stringify(claim))}`;

  /** A Node agent, as the desktop app runs it; for a phone, the same code with a phone's claim. */
  function agent(claim: EgressAgentClaim) {
    const roles: AgentRole[] = [];
    const lookups: string[] = [];
    let hang = false;
    const instance = new EgressAgent({
      getUrl: async () => agentUrl(claim),
      onRole: (role) => roles.push(role),
      resolve: async (host) => {
        lookups.push(host);
        if (hang) await new Promise(() => {});
        return "127.0.0.1";
      },
    });
    instance.start();
    cleanups.push(() => instance.stop());
    return {
      instance,
      roles,
      lookups,
      get role() {
        return roles.at(-1);
      },
      hangConnects(value: boolean) {
        hang = value;
      },
    };
  }

  const desktop = (id = "mac-0001") => agent({ kind: "desktop", id, name: "Mac" });
  const phone = (id = PHONE_ID, generation = 1) =>
    agent({ kind: "phone", id, name: "Phone", generation });

  /** A raw websocket agent, for old or misbehaving clients. */
  function rawAgent(claim: EgressAgentClaim, options: { autoPong?: boolean } = {}) {
    const socket = new WebSocket(agentUrl(claim), { autoPong: options.autoPong ?? true });
    socket.on("error", () => {});
    const texts: ControlMessage[] = [];
    const frames: Buffer[] = [];
    socket.on("message", (data, isBinary) => {
      if (isBinary) frames.push(data as Buffer);
      else texts.push(JSON.parse(data.toString()) as ControlMessage);
    });
    cleanups.push(() => socket.terminate());
    return { socket, texts, frames };
  }

  const connect = async (port: number) => {
    const socket = await socksConnect(socksPort, "127.0.0.1", port);
    cleanups.push(() => void socket.destroy());
    return socket;
  };

  return {
    store,
    router,
    relay,
    wake,
    pushes,
    onPush: (handler: (stage: "wake" | "ask") => void) => (onPush = handler),
    tunnels,
    desktop,
    phone,
    rawAgent,
    connect,
  };
}

describe("egress relay", () => {
  it("pauses only the computer tunnel and keeps desktop/phone agents attached through stale reconnect timers", async () => {
    const env = await setup();
    env.desktop();
    const phone = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(
      () => env.relay.status.agents.length >= 1 && env.relay.computerConnected,
      "agents and computer",
    );
    const before = env.tunnels.length;
    env.relay.pauseComputer();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(env.relay.computerConnected).toBe(false);
    expect(env.relay.status.agents.some((agent) => agent.kind === "desktop")).toBe(true);
    expect(phone.socket.readyState).toBe(WebSocket.OPEN);
    expect(env.tunnels.length).toBe(before);
    await env.relay.resumeComputer();
    await until(() => env.relay.computerConnected, "computer resumes");
    expect(env.relay.status.agents.some((agent) => agent.kind === "desktop")).toBe(true);
  });

  it("reloads durable routing and revocations before resuming a sleeping computer", async () => {
    const env = await setup();
    const phone = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(() => env.relay.status.agents.some((a) => a.kind === "phone"), "phone attached");
    env.relay.pauseComputer();
    // Simulate a saved edit whose notification was lost. Periodic reconciliation is not enough.
    env.store.mode = "require";
    env.store.phones = [];
    await env.relay.resumeComputer();
    await until(
      () => env.relay.computerConnected && env.router.state.mode === "require",
      "fresh configuration applied",
    );
    await until(() => phone.socket.readyState !== WebSocket.OPEN, "revoked phone disconnected");
    expect(env.relay.status.agents.some((a) => a.kind === "phone")).toBe(false);
    expect(env.router.state.agentOnline).toBe(false);
  });

  it("carries connections through the desktop, with a status that matches the API schema", async () => {
    const env = await setup();
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    await until(() => env.router.state.agentOnline, "botd to see a device");

    const socket = await env.connect(port);
    expect(await echo(socket, "hello")).toBe("hello");
    expect(mac.lookups).toEqual(["127.0.0.1"]);
    socket.end();

    const status = egressStatusSchema.parse(env.relay.status);
    expect(status.path).toBe("desktop");
    expect(status.agents).toMatchObject([{ kind: "desktop", role: "active" }]);
    expect(status.phones).toMatchObject([{ id: PHONE_ID, online: false }]);
  });

  it("prefers the Mac in fallback and lets the standby phone go after the grace", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const phone = env.phone();
    await until(() => phone.role === "standby", "the phone to stand by");
    expect(env.relay.status.agents.map((agent) => [agent.kind, agent.role])).toEqual([
      ["desktop", "active"],
      ["phone", "standby"],
    ]);
    await until(() => phone.role === "release", "the phone's release");
    expect(phone.roles).toEqual(["standby", "release"]);
  });

  it("prefers the phone in always, and the Mac stands by", async () => {
    const env = await setup({ phoneMode: "always" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const phone = env.phone();
    await until(() => phone.role === "active" && mac.role === "standby", "the phone to take over");
    const socket = await env.connect(port);
    expect(await echo(socket, "via phone")).toBe("via phone");
    expect(phone.lookups).toHaveLength(1);
    expect(mac.lookups).toHaveLength(0);
    expect(env.relay.status.path).toBe("phone");
  });

  it("releases phones at once when the phone mode is off, and tells them the policy", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(
      () => raw.texts.some((message) => message.type === "role" && message.role === "active"),
      "the phone to be active",
    );
    expect(raw.texts).toContainEqual({ type: "policy", phoneMode: "fallback" });
    await env.relay.setPhoneMode("off");
    await until(
      () => raw.texts.some((message) => message.type === "role" && message.role === "release"),
      "the release",
    );
    expect(raw.texts).toContainEqual({ type: "policy", phoneMode: "off" });
    expect(env.relay.status.path).toBe("direct");
  });

  it("keeps a draining Mac's stream working after a switch, then resets it at the grace end", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const old = await env.connect(port);
    expect(await echo(old, "before")).toBe("before");
    const phone = env.phone();
    await until(() => phone.role === "standby", "the phone to stand by");

    await env.relay.setPhoneMode("always");
    await until(() => phone.role === "active" && mac.role === "standby", "the switch");
    // The old stream still goes through the Mac; new ones go through the phone.
    expect(await echo(old, "during")).toBe("during");
    const fresh = await env.connect(port);
    expect(await echo(fresh, "new")).toBe("new");
    expect(phone.lookups).toHaveLength(1);

    const closed = new Promise((resolve) => old.once("close", resolve));
    await closed;
    expect(await echo(fresh, "still")).toBe("still");
  });

  it("re-routes a connection whose device left before it opened", async () => {
    // A long grace, so the standby phone is still there.
    const env = await setup({ phoneMode: "fallback", timings: { drainMs: 10_000 } });
    const port = await echoServer();
    const mac = env.desktop();
    const phone = env.phone();
    await until(() => mac.role === "active" && phone.role === "standby", "the roles");
    mac.hangConnects(true);
    const pending = env.connect(port);
    await until(() => mac.lookups.length === 1, "the Mac to start opening");
    mac.instance.stop();
    const socket = await pending;
    expect(await echo(socket, "re-routed")).toBe("re-routed");
    expect(phone.lookups).toHaveLength(1);
  });

  it("goes direct in prefer, and refuses in require, when the last device leaves while opening", async () => {
    const env = await setup({ phoneMode: "off" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    mac.hangConnects(true);
    const pending = env.connect(port);
    await until(() => mac.lookups.length === 1, "the Mac to start opening");
    mac.instance.stop();
    const direct = await pending;
    expect(await echo(direct, "direct")).toBe("direct");

    await env.relay.setMode("require");
    await until(() => env.router.state.mode === "require", "botd to see require");
    await expect(env.connect(port)).rejects.toThrow("SOCKS reply 2");
    expect(env.router.state.refusedRecently).toBe(1);
    expect(env.relay.status.path).toBe("blocked");
  });

  it("answers AGENT_GONE when no device is connected", async () => {
    const env = await setup();
    // Speak to the relay as a computer would, on the tunnel botd holds.
    const tunnel = env.tunnels[0]!;
    const answers: { type: number; reason: string }[] = [];
    tunnel.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(data as Buffer);
      answers.push({ type: frame.type, reason: frame.payload.toString() });
    });
    tunnel.send(encodeFrame(FrameType.Open, 1001, JSON.stringify({ host: "x", port: 1 })));
    await until(() => answers.length === 1, "the answer");
    expect(answers).toEqual([{ type: FrameType.OpenFail, reason: AGENT_GONE }]);
  });

  it("drops frames from an agent for streams it doesn't own", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const intruder = env.rawAgent({ kind: "desktop", id: "mac-0002-old", name: "Old Mac" });
    // The newest desktop wins; let the original one win again by reconnecting it.
    await until(() => intruder.texts.some((m) => m.type === "role"), "the intruder's role");
    mac.instance.stop();
    mac.instance.start();
    await until(() => mac.role === "active" && mac.roles.length >= 2, "the Mac back");
    const socket = await env.connect(port);
    // Stream 1 is the Mac's; the standby agent can't touch it, and gets a reset for its data.
    intruder.socket.send(encodeFrame(FrameType.Data, 1, "injected"));
    intruder.socket.send(encodeFrame(FrameType.Reset, 1));
    await until(() => intruder.frames.length === 1, "the intruder's reset");
    expect(decodeFrame(intruder.frames[0]!).type).toBe(FrameType.Reset);
    expect(await echo(socket, "untouched")).toBe("untouched");
  });

  it("starts a new generation when the computer reconnects; late frames from before go nowhere", async () => {
    // In require, the connection that was opening is refused rather than sent direct.
    const env = await setup({ mode: "require", phoneMode: "off" });
    const port = await echoServer();
    const raw = env.rawAgent({ kind: "desktop", id: "mac-0003", name: "Mac" });
    await until(() => raw.texts.some((m) => m.type === "role" && m.role === "active"), "active");
    await until(() => env.router.state.agentOnline, "botd to see the device");
    const pending = env.connect(port).catch((error: Error) => error);
    await until(() => raw.frames.length === 1, "the open");
    const open = decodeFrame(raw.frames[0]!);
    expect(open.type).toBe(FrameType.Open);

    env.tunnels[0]!.terminate();
    await until(() => raw.texts.some((m) => m.type === "peer-down"), "peer-down");
    await until(() => env.tunnels.length === 2 && env.relay.computerConnected, "the new tunnel");
    // A late answer for the old stream: the relay forgot it, so it reaches nothing.
    raw.socket.send(encodeFrame(FrameType.OpenFail, open.streamId, "too late"));
    raw.socket.send(encodeFrame(FrameType.Data, open.streamId, "late"));
    await until(() => raw.frames.length === 2, "the reset for late data");
    expect(decodeFrame(raw.frames[1]!).type).toBe(FrameType.Reset);
    expect(await pending).toBeInstanceOf(Error);
  });

  it("treats an agent that ignores role messages as a working desktop", async () => {
    const env = await setup({ phoneMode: "off" });
    const raw = env.rawAgent({ kind: "desktop", id: "desktop", name: "Desktop app" });
    await until(() => env.relay.status.agentOnline, "the legacy agent");
    expect(env.relay.status.agents).toMatchObject([{ id: "desktop", role: "active" }]);
    expect(raw.texts.some((m) => m.type === "role")).toBe(true);
  });

  it("terminates an agent that stops answering pings", async () => {
    const env = await setup();
    const raw = env.rawAgent({ kind: "desktop", id: "mac-0004", name: "Mac" }, { autoPong: false });
    await until(() => env.relay.status.agentOnline, "the agent");
    const closed = new Promise((resolve) => raw.socket.once("close", resolve));
    await closed;
    expect(env.relay.status.agentOnline).toBe(false);
  });

  it("refuses a phone whose pairing was revoked or replaced", async () => {
    const env = await setup();
    env.store.unpair(PHONE_ID);
    const revoked = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    const code = await new Promise((resolve) => revoked.socket.once("close", resolve));
    expect(code).toBe(CLOSE_REVOKED);

    env.store.pair(PHONE_ID, 2);
    const stale = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    expect(await new Promise((resolve) => stale.socket.once("close", resolve))).toBe(CLOSE_REVOKED);
    const current = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 2 });
    // The relay adopts the phone once the server's side is open, which can be before the client's.
    await until(
      () =>
        env.relay.connectedPhones.includes(PHONE_ID) &&
        current.socket.readyState === WebSocket.OPEN,
      "the re-paired phone",
    );
    expect(current.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("lets a revoke that arrives during an attach win", async () => {
    const env = await setup();
    let release!: () => void;
    env.store.readDelay = new Promise((resolve) => (release = resolve));
    const reads = env.store.reads;
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(() => env.store.reads > reads, "the attach to read the pairing");
    // The attach is reading the pairing; the revoke happens in the database and is queued.
    env.store.unpair(PHONE_ID);
    const revoking = env.relay.revoke(PHONE_ID, 1);
    env.store.readDelay = null;
    release();
    await revoking;
    expect(await new Promise((resolve) => raw.socket.once("close", resolve))).toBe(CLOSE_REVOKED);
    expect(env.relay.connectedPhones).toEqual([]);
  });

  it("ignores a delayed revoke of an older pairing", async () => {
    const env = await setup();
    env.store.pair(PHONE_ID, 2);
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 2 });
    await until(
      () =>
        env.relay.connectedPhones.includes(PHONE_ID) && raw.socket.readyState === WebSocket.OPEN,
      "the phone",
    );
    await env.relay.revoke(PHONE_ID, 1);
    expect(raw.socket.readyState).toBe(WebSocket.OPEN);
    expect(env.relay.connectedPhones).toEqual([PHONE_ID]);
  });

  it("catches a lost revoke with the reconciler", async () => {
    const env = await setup();
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(() => env.relay.connectedPhones.includes(PHONE_ID), "the phone");
    env.store.unpair(PHONE_ID);
    expect(await new Promise((resolve) => raw.socket.once("close", resolve))).toBe(CLOSE_REVOKED);
  });

  it("releases an extra phone once it has nothing to carry", async () => {
    const env = await setup({ phoneMode: "always" });
    env.store.pair(PHONE_2_ID);
    const first = env.phone(PHONE_ID);
    await until(() => first.role === "active", "the first phone");
    const second = env.phone(PHONE_2_ID);
    await until(() => second.role === "active" && first.role === "release", "the newer phone");
  });

  it("keeps control traffic flowing to one agent while another is slow", async () => {
    const env = await setup({ phoneMode: "always" });
    const port = await echoServer();
    // A standby desktop that never reads (its socket is paused) can't hold up the phone.
    const slow = env.rawAgent({ kind: "desktop", id: "mac-0005", name: "Slow Mac" });
    await new Promise((resolve) => slow.socket.once("open", resolve));
    (slow.socket as unknown as { _socket: Socket })._socket.pause();
    const phone = env.phone();
    await until(() => phone.role === "active", "the phone");
    const socket = await env.connect(port);
    const big = "x".repeat(256 * 1024);
    expect((await echo(socket, big)).length).toBe(big.length);
  });
  it("wakes the phone when a screen needs browsing, and holds the connection until it's there", async () => {
    const env = await setup({ mode: "require", phoneMode: "fallback" });
    const port = await echoServer();
    // The wake reaches the phone, which connects a moment later.
    let phone: ReturnType<typeof env.phone> | null = null;
    env.onPush((stage) => {
      if (stage === "wake" && !phone) setTimeout(() => (phone = env.phone()), 200);
    });
    await until(() => env.router.state.configured, "the config");
    env.router.noteDemand("bot-1");
    await until(() => env.pushes.length === 1, "the wake");
    expect(env.relay.status.path).toBe("waiting");
    expect(env.relay.status.phones[0]!.waking).toMatchObject({ stage: "wake" });

    const socket = await env.connect(port);
    expect(await echo(socket, "through the woken phone")).toBe("through the woken phone");
    expect(phone!.lookups).toHaveLength(1);
    expect(env.relay.status.path).toBe("phone");
    expect(env.relay.status.phones[0]).toMatchObject({ online: true, waking: null });
  });

  it("stops waking a phone that says it can't help, and botd stops holding for it", async () => {
    const env = await setup({ mode: "require", phoneMode: "fallback" });
    const port = await echoServer();
    env.onPush((stage) => {
      if (stage !== "wake") return;
      const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
      raw.socket.once("open", () => {
        raw.socket.send(JSON.stringify({ type: "unavailable", reason: "wifi-only" }));
        raw.socket.close();
      });
    });
    env.router.noteDemand("bot-1");
    await until(() => env.relay.status.phones[0]!.unavailable !== null, "the report");
    expect(env.relay.status.phones[0]!.unavailable).toMatchObject({
      reason: "wifi-only",
      message: "Phone is on mobile data",
    });
    await until(() => !env.router.state.agentOnline, "the phone to leave");
    await expect(env.connect(port)).rejects.toThrow("SOCKS reply 2");
  });

  it("takes a phone's word that it is back over a report still on its way", async () => {
    const env = await setup({ mode: "require", phoneMode: "fallback" });
    const first = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    first.socket.once("open", () =>
      first.socket.send(JSON.stringify({ type: "unavailable", reason: "wifi-only", seq: 2 })),
    );
    await until(() => env.relay.status.phones[0]!.unavailable !== null, "the report");
    first.socket.close();
    await until(() => env.relay.status.phones[0]!.online === false, "the phone to leave");

    const second = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    second.socket.once("open", () =>
      second.socket.send(JSON.stringify({ type: "available", seq: 2 })),
    );
    await until(() => env.relay.status.phones[0]!.online === true, "the phone");
    await until(() => env.relay.status.phones[0]!.unavailable === null, "the report to clear");
    // The same report, late through the device route, doesn't count again.
    env.wake.unavailable(PHONE_ID, "wifi-only", 2);
    expect(env.relay.status.phones[0]!.unavailable).toBeNull();
  });
});
