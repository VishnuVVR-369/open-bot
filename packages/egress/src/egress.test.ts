import { createHash, randomBytes } from "node:crypto";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, resolvePublicAddress } from "./ip-policy";
import { decodeFrame, FrameType } from "./frames";
import { INITIAL_WINDOW, Mux } from "./mux";
import { connectDirect, createSocksServer, socksReply, SocksReply } from "./socks";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

/** Connect through a SOCKS5 proxy and return the connected socket. */
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
        const request = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([port >> 8, port & 0xff]),
        ]);
        socket.write(request);
      }
      if (stage === 1 && buffer.length >= 10) {
        socket.off("data", onData);
        if (buffer[1] !== 0x00) {
          reject(new Error(`SOCKS reply ${buffer[1]}`));
          return;
        }
        const rest = buffer.subarray(10);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

/** Wire a computer-side and an agent-side mux together, as the worker relay does. */
function linkedMuxes(
  connect: (host: string, port: number) => Promise<Socket>,
  /** Sees every frame either side sends. */
  onFrame: (frame: Buffer) => void = () => {},
) {
  let agent: Mux | null = null;
  const computer = new Mux({
    role: "computer",
    send: (frame) => {
      onFrame(frame);
      setImmediate(() => agent!.handleFrame(frame));
    },
  });
  agent = new Mux({
    role: "agent",
    send: (frame) => {
      onFrame(frame);
      setImmediate(() => computer.handleFrame(frame));
    },
    connect,
  });
  return { computer, agent };
}

function connectLocal(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.pause();
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

describe("ip policy", () => {
  it("allows public addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("blocks private, loopback, link-local and mapped addresses", () => {
    for (const address of [
      "10.1.2.3",
      "192.168.1.10",
      "172.20.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.1.1",
      "::1",
      "fe80::1",
      "fd12::1",
      "::ffff:192.168.1.1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses names that resolve to any private address", async () => {
    await expect(
      resolvePublicAddress("router.local", async () => [
        { address: "93.184.215.14", family: 4 },
        { address: "192.168.0.1", family: 4 },
      ]),
    ).rejects.toThrow(/blocked/);
    await expect(
      resolvePublicAddress("example.com", async () => [{ address: "93.184.215.14", family: 4 }]),
    ).resolves.toBe("93.184.215.14");
    await expect(resolvePublicAddress("[::1]")).rejects.toThrow(/blocked/);
  });
});

/** Both ends of a local TCP connection: `client` plays the SOCKS client's socket in the proxy. */
async function socketPair(): Promise<{ client: Socket; peer: Socket }> {
  let accepted!: (socket: Socket) => void;
  const client = new Promise<Socket>((resolve) => (accepted = resolve));
  const port = await listen(net.createServer((socket) => accepted(socket)));
  const peer = net.connect(port, "127.0.0.1");
  return { client: await client, peer };
}

describe("connectDirect", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A destination that never answers, like one behind a dropping firewall. */
  function silentDestination(): Socket {
    const upstream = new net.Socket();
    vi.spyOn(net, "connect").mockReturnValue(upstream);
    return upstream;
  }

  it("gives up at the deadline, with a failure reply", async () => {
    const { client, peer } = await socketPair();
    const upstream = silentDestination();
    const reply = new Promise<Buffer>((resolve) => peer.once("data", resolve));
    await expect(
      connectDirect("example.com", 443, client, { deadline: Date.now() + 50 }),
    ).rejects.toThrow("Timed out connecting to example.com:443");
    expect(upstream.destroyed).toBe(true);
    expect((await reply)[1]).toBe(SocksReply.hostUnreachable);
    peer.destroy();
  });

  it("closes the client when the destination resets an open connection", async () => {
    const destination = await listen(
      net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy())),
    );
    const { client, peer } = await socketPair();
    const peerClosed = new Promise((resolve) => peer.once("close", resolve));
    peer.on("error", () => {});
    peer.resume(); // Read the SOCKS reply, or the close waits for it to be.
    await connectDirect("127.0.0.1", destination, client, { deadline: Date.now() + 5_000 });
    peer.write("GET");
    await peerClosed;
    expect(client.destroyed).toBe(true);
  });

  it("settles when the client leaves before the destination answers", async () => {
    const { client, peer } = await socketPair();
    const upstream = silentDestination();
    const settled = connectDirect("example.com", 443, client);
    peer.destroy();
    await expect(settled).resolves.toBeUndefined();
    expect(upstream.destroyed).toBe(true);
  });
});

describe("egress tunnel", () => {
  it("relays a request and a large response through SOCKS and the mux", async () => {
    const payload = randomBytes(5 * 1024 * 1024);
    const targetPort = await listen(
      net.createServer((socket) => {
        socket.once("data", (request) => {
          expect(request.toString()).toBe("GET");
          socket.end(payload);
        });
      }),
    );
    const { computer } = linkedMuxes(connectLocal);
    const proxyPort = await listen(
      createSocksServer(async (host, port, client) => {
        const streamId = await computer.open(host, port);
        client.write(socksReply(SocksReply.succeeded));
        computer.attach(streamId, client);
      }),
    );

    const socket = await socksConnect(proxyPort, "127.0.0.1", targetPort);
    const received: Buffer[] = [];
    socket.on("data", (chunk) => received.push(chunk));
    socket.write("GET");
    await new Promise((resolve) => socket.once("end", resolve));
    const body = Buffer.concat(received);
    expect(body.length).toBe(payload.length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
  });

  it("finishes a stream without a reset when the server closes right after sending", async () => {
    // A reset aborts the other side at once, dropping whatever it hasn't written to its client
    // yet, so a clean close (like an HTTP server's after its response) must only send End.
    const payload = randomBytes(INITIAL_WINDOW / 2);
    const targetPort = await listen(
      net.createServer((socket) => socket.once("data", () => socket.end(payload))),
    );
    const sent: FrameType[] = [];
    const { computer } = linkedMuxes(connectLocal, (frame) => sent.push(decodeFrame(frame).type));
    const proxyPort = await listen(
      createSocksServer(async (host, port, client) => {
        const streamId = await computer.open(host, port);
        client.write(socksReply(SocksReply.succeeded));
        computer.attach(streamId, client);
      }),
    );

    const socket = await socksConnect(proxyPort, "127.0.0.1", targetPort);
    const received: Buffer[] = [];
    socket.on("data", (chunk) => received.push(chunk));
    socket.write("GET");
    await new Promise((resolve) => socket.once("close", resolve));
    await vi.waitFor(() => expect(computer.stats.openStreams).toBe(0));

    expect(Buffer.concat(received).equals(payload)).toBe(true);
    expect(sent).toContain(FrameType.End);
    expect(sent).not.toContain(FrameType.Reset);
  });

  it("tells a client still sending that the server closed", async () => {
    const targetPort = await listen(
      net.createServer((socket) => socket.once("data", () => socket.end("413 Too Large"))),
    );
    const { computer } = linkedMuxes(connectLocal);
    const proxyPort = await listen(
      createSocksServer(async (host, port, client) => {
        const streamId = await computer.open(host, port);
        client.write(socksReply(SocksReply.succeeded));
        computer.attach(streamId, client);
      }),
    );

    const socket = await socksConnect(proxyPort, "127.0.0.1", targetPort);
    // Keeps sending after the response ends, like an upload the server turned down early.
    socket.allowHalfOpen = true;
    socket.on("error", () => {});
    socket.resume();
    const upload = setInterval(() => socket.write(randomBytes(256 * 1024)), 5);
    await new Promise((resolve) => socket.once("close", resolve));
    clearInterval(upload);
    await vi.waitFor(() => expect(computer.stats.openStreams).toBe(0));
  });

  it("reports a refused destination to the SOCKS client", async () => {
    const { computer } = linkedMuxes(async () => {
      throw new Error("blocked");
    });
    const proxyPort = await listen(
      createSocksServer(async (host, port, client) => {
        try {
          const streamId = await computer.open(host, port);
          client.write(socksReply(SocksReply.succeeded));
          computer.attach(streamId, client);
        } catch {
          client.end(socksReply(SocksReply.notAllowed));
        }
      }),
    );
    await expect(socksConnect(proxyPort, "192.168.1.1", 80)).rejects.toThrow(/SOCKS reply 2/);
  });

  it("drops open streams when the tunnel resets", async () => {
    const targetPort = await listen(net.createServer(() => {}));
    const { computer, agent } = linkedMuxes(connectLocal);
    const proxyPort = await listen(
      createSocksServer(async (host, port, client) => {
        const streamId = await computer.open(host, port);
        client.write(socksReply(SocksReply.succeeded));
        computer.attach(streamId, client);
      }),
    );
    const socket = await socksConnect(proxyPort, "127.0.0.1", targetPort);
    expect(computer.stats.openStreams).toBe(1);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    // The worker tells both sides to drop their streams when either side disconnects.
    computer.resetAll();
    agent.resetAll();
    await closed;
    expect(computer.stats.openStreams).toBe(0);
  });
});
