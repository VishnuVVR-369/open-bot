// What the egress relay tests share: a botd router and tunnel endpoint, the relay with a stand-in
// store, the wake controller, and agents (Node, as the desktop app runs it, or raw websockets).
import { mkdtempSync } from "node:fs";
import net, { type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { EgressAgent, type AgentRole, type ControlMessage } from "@open-bot/egress";
import type { EgressMode, PhoneMode } from "@open-bot/domain";
import type { EgressAgentClaim } from "@open-bot/domain/server";
import WebSocket, { WebSocketServer } from "ws";
// The real computer side, as botd runs it.
import { EgressRouter } from "@open-bot/egress/router";
import { EgressRelay, type PairedPhone, type RelayStore } from "./relay";
import { WakeController } from "./wake";

export const PHONE_ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";
export const PHONE_2_ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a02";
const TIMINGS = { heartbeatMs: 100, drainMs: 400, reconcileMs: 150, computerRetryMs: 50 };

const cleanups: (() => void | Promise<void>)[] = [];
/** Undoes what the last test set up, newest first. Each relay test file runs it after each test. */
export async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
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
export async function echoServer(): Promise<number> {
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

export async function echo(socket: Socket, text: string): Promise<string> {
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

export async function setup(
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
