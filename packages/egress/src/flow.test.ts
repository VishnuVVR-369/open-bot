import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_GONE,
  decodeFrame,
  encodeFrame,
  encodeWindow,
  FrameType,
  parseControlMessage,
} from "./frames";
import { BlockedDestinationError, isPublicAddress, resolvePublicAddress } from "./ip-policy";
import {
  INITIAL_WINDOW,
  MAX_FRAME_PAYLOAD,
  MAX_IN_FLIGHT,
  Mux,
  OpenError,
  TRANSPORT_HIGH_WATER,
} from "./mux";
import { embedIPv4, RFC6052_PREFIXES } from "./vectors";

/** A local socket the test drives by hand. */
class FakeSocket extends EventEmitter {
  paused = false;
  destroyed = false;
  writes: Buffer[] = [];
  write(chunk: Buffer, callback?: () => void) {
    this.writes.push(chunk);
    callback?.();
    return true;
  }
  end() {
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  isPaused() {
    return this.paused;
  }
}
const asSocket = (socket: FakeSocket) => socket as unknown as Socket;

describe("ip policy hardening", () => {
  it("applies the IPv4 rules to addresses embedded in IPv6", () => {
    expect(isPublicAddress("64:ff9b::a00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
    expect(isPublicAddress("2002:c0a8:101::1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
  });

  it("refuses ranges that hide where traffic goes", () => {
    for (const address of [
      "64:ff9b:1::808:808",
      "::8.8.8.8",
      "2001:0:4136:e378::1",
      "100::1",
      "2001:db8::1",
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });

  it("decodes a network's own NAT64 prefix in every RFC 6052 layout", () => {
    // RFC 6052 section 2.4's examples, for 192.0.2.33.
    const expected = [
      "2001:db8:c000:221::",
      "2001:db8:1c0:2:21::",
      "2001:db8:122:c000:2:2100::",
      "2001:db8:122:3c0:0:221::",
      "2001:db8:122:344:c0:2:2100::",
      "2001:db8:122:344::c000:221",
    ];
    RFC6052_PREFIXES.forEach((prefix, index) => {
      const embedded = embedIPv4(prefix, "192.0.2.33");
      expect(isPublicAddress(embedded, { nat64: [prefix] })).toBe(true);
      expect(isPublicAddress(expected[index]!, { nat64: [prefix] })).toBe(true);
      expect(isPublicAddress(embedIPv4(prefix, "10.0.0.1"), { nat64: [prefix] })).toBe(false);
    });
  });

  it("refuses a DNS64 answer that hides a private address", async () => {
    const nat64 = [{ prefix: "2001:db8:64::", length: 96 as const }];
    await expect(
      resolvePublicAddress(
        "internal.example",
        async () => [{ address: "2001:db8:64::a00:1", family: 6 }],
        { nat64 },
      ),
    ).rejects.toBeInstanceOf(BlockedDestinationError);
  });
});

describe("control messages", () => {
  it("parses known messages and drops malformed ones", () => {
    expect(parseControlMessage('{"type":"role","role":"standby"}')).toEqual({
      type: "role",
      role: "standby",
    });
    expect(
      parseControlMessage(
        '{"type":"config","mode":"require","agentOnline":false,"holdMs":5000,"wakeable":true}',
      ),
    ).toEqual({
      type: "config",
      mode: "require",
      agentOnline: false,
      holdMs: 5000,
      wakeable: true,
    });
    expect(parseControlMessage('{"type":"role","role":"boss"}')).toBeNull();
    expect(parseControlMessage('{"type":"unknown"}')).toBeNull();
  });
});

describe("mux opening", () => {
  function computerSide() {
    const sent: Buffer[] = [];
    const mux = new Mux({ role: "computer", send: (frame) => sent.push(frame) });
    return { mux, sent };
  }

  it("settles an open at once when the other side resets it", async () => {
    const { mux } = computerSide();
    const opening = mux.open("example.com", 443);
    mux.handleFrame(encodeFrame(FrameType.Reset, 1));
    await expect(opening).rejects.toBeInstanceOf(OpenError);
    expect(mux.stats.openStreams).toBe(0);
  });

  it("marks a relay's AGENT_GONE as retryable and other failures as not", async () => {
    const { mux } = computerSide();
    const gone = mux.open("example.com", 443);
    const refused = mux.open("example.com", 443);
    mux.handleFrame(encodeFrame(FrameType.OpenFail, 1, AGENT_GONE));
    mux.handleFrame(encodeFrame(FrameType.OpenFail, 3, "Connection refused"));
    await expect(gone).rejects.toMatchObject({ agentGone: true });
    await expect(refused).rejects.toMatchObject({
      agentGone: false,
      message: "Connection refused",
    });
  });

  it("gives up at the caller's deadline and tells the other side", async () => {
    vi.useFakeTimers();
    try {
      const { mux, sent } = computerSide();
      const opening = mux.open("example.com", 443, { deadline: Date.now() + 2_000 });
      opening.catch(() => {});
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(opening).rejects.toThrow(/Timed out/);
      expect(sent.map((frame) => decodeFrame(frame).type)).toEqual([
        FrameType.Open,
        FrameType.Reset,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the agent's connection when the stream is reset while connecting", async () => {
    let signal: AbortSignal | null = null;
    const sent: Buffer[] = [];
    const mux = new Mux({
      role: "agent",
      send: (frame) => sent.push(frame),
      connect: (_host, _port, abort) => {
        signal = abort;
        return new Promise(() => {});
      },
    });
    mux.handleFrame(encodeFrame(FrameType.Open, 1, '{"host":"example.com","port":443}'));
    mux.handleFrame(encodeFrame(FrameType.Reset, 1));
    expect(signal!.aborted).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("mux flow control", () => {
  /** An agent-side mux whose destinations the test controls, with a transport it can back up. */
  function agentSide(streams: number) {
    const sent: Buffer[] = [];
    const sockets: FakeSocket[] = [];
    let buffered = 0;
    const mux = new Mux({
      role: "agent",
      send: (frame) => sent.push(frame),
      connect: async () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return asSocket(socket);
      },
      transportBuffered: () => buffered,
    });
    for (let index = 0; index < streams; index++)
      mux.handleFrame(
        encodeFrame(FrameType.Open, index * 2 + 1, '{"host":"example.com","port":443}'),
      );
    return {
      mux,
      sent,
      sockets,
      setBuffered: (value: number) => (buffered = value),
    };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("pauses every stream once too much is in flight, and resumes with credit", async () => {
    const streams = MAX_IN_FLIGHT / INITIAL_WINDOW + 1;
    const { mux, sockets } = agentSide(streams);
    await flush();
    const chunk = Buffer.alloc(MAX_FRAME_PAYLOAD);
    // Every stream sends half its window: nothing pauses for its own window.
    for (const socket of sockets)
      for (let sent = 0; sent < INITIAL_WINDOW / 2; sent += chunk.length)
        socket.emit("data", chunk);
    expect(mux.uncredited).toBe((streams * INITIAL_WINDOW) / 2);
    expect(sockets.every((socket) => !socket.paused)).toBe(true);
    for (const socket of sockets)
      for (let sent = 0; sent < INITIAL_WINDOW / 2 - chunk.length; sent += chunk.length)
        socket.emit("data", chunk);
    expect(mux.uncredited).toBeGreaterThan(MAX_IN_FLIGHT);
    expect(sockets.every((socket) => socket.paused)).toBe(true);
    mux.handleFrame(encodeWindow(1, INITIAL_WINDOW));
    expect(mux.uncredited).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(sockets.every((socket) => !socket.paused)).toBe(true);
  });

  it("stops reading while the transport is backed up and resumes when it drains, with no new sends", async () => {
    vi.useFakeTimers();
    try {
      const { sockets, sent, setBuffered, mux } = agentSide(256);
      await vi.advanceTimersByTimeAsync(0);
      setBuffered(TRANSPORT_HIGH_WATER + 1);
      sockets[0]!.emit("data", Buffer.from("x"));
      expect(sockets.every((socket) => socket.paused)).toBe(true);
      // Credit still flows while paused: writes to a destination are acknowledged.
      const before = sent.length;
      mux.handleFrame(encodeFrame(FrameType.Data, 3, "payload"));
      expect(decodeFrame(sent.at(-1)!).type).toBe(FrameType.Window);
      expect(sent.length).toBe(before + 1);
      setBuffered(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(sockets.every((socket) => !socket.paused)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
