import net, { type Socket } from "node:net";

/**
 * A minimal SOCKS5 server (no auth, CONNECT only) for Chromium inside the computer.
 * Hostnames arrive unresolved, so DNS happens wherever the connection is finally opened.
 */

export type Route = (host: string, port: number, client: Socket) => Promise<void>;

const REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  notAllowed: 0x02,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const;

export type SocksReplyCode = (typeof REPLY)[keyof typeof REPLY];
export const SocksReply = REPLY;

export function socksReply(code: SocksReplyCode): Buffer {
  // VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

class Reader {
  private buffer = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private failed: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.once("error", (error) => this.fail(error));
    socket.once("close", () => this.fail(new Error("Client closed")));
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.waiter?.();
  };

  private fail(error: Error) {
    this.failed = error;
    this.waiter?.();
  }

  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      if (this.failed) throw this.failed;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = null;
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  /** Stop reading and hand any bytes that were already buffered back to the socket's consumer. */
  detach(): Buffer {
    this.socket.off("data", this.onData);
    // Explicitly pause, so no bytes are lost before the next consumer attaches and resumes.
    this.socket.pause();
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

async function handshake(socket: Socket): Promise<{ host: string; port: number; rest: Buffer }> {
  const reader = new Reader(socket);
  const [version, methodCount] = await reader.read(2);
  if (version !== 0x05) throw new Error("Not a SOCKS5 client");
  const methods = await reader.read(methodCount ?? 0);
  if (!methods.includes(0x00)) {
    socket.end(Buffer.from([0x05, 0xff]));
    throw new Error("Client requires authentication");
  }
  socket.write(Buffer.from([0x05, 0x00]));

  const [, command, , addressType] = await reader.read(4);
  let host: string;
  if (addressType === 0x01) {
    host = [...(await reader.read(4))].join(".");
  } else if (addressType === 0x03) {
    const [length] = await reader.read(1);
    host = (await reader.read(length ?? 0)).toString("utf8");
  } else if (addressType === 0x04) {
    const raw = await reader.read(16);
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(raw.readUInt16BE(i).toString(16));
    host = parts.join(":");
  } else {
    socket.end(socksReply(REPLY.addressTypeNotSupported));
    throw new Error("Unsupported address type");
  }
  const port = (await reader.read(2)).readUInt16BE(0);
  if (command !== 0x01) {
    socket.end(socksReply(REPLY.commandNotSupported));
    throw new Error("Only CONNECT is supported");
  }
  return { host, port, rest: reader.detach() };
}

export function createSocksServer(route: Route, onError?: (error: unknown) => void): net.Server {
  return net.createServer((client) => {
    client.setNoDelay(true);
    handshake(client)
      .then(async ({ host, port, rest }) => {
        if (rest.length > 0) client.unshift(rest);
        await route(host, port, client);
      })
      .catch((error: unknown) => {
        onError?.(error);
        if (!client.destroyed) client.destroy();
      });
  });
}

/** Route a SOCKS client straight to the destination from this machine. */
export function connectDirect(host: string, port: number, client: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const upstream = net.connect({ host, port });
    upstream.setNoDelay(true);
    upstream.once("connect", () => {
      client.write(socksReply(REPLY.succeeded));
      client.pipe(upstream);
      upstream.pipe(client);
      resolve();
    });
    upstream.once("error", (error) => {
      if (!client.destroyed) client.end(socksReply(REPLY.hostUnreachable));
      reject(error);
    });
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  });
}
