/**
 * Test vectors for the phone's Kotlin agent, generated from this package's code so the two
 * implementations can't drift apart. `vectors.test.ts` checks the files in `test-vectors/` match
 * (run `pnpm --filter @open-bot/egress vectors` to write them after a deliberate change).
 *
 * Mux scenarios drive an agent-side `Mux` with scripted frames and fake destination sockets, and
 * record what it sends and does after every step.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { EGRESS_MODES, PHONE_MODES, UNAVAILABLE_REASONS } from "@open-bot/domain";
import {
  AGENT_GONE,
  AGENT_ROLES,
  decodeFrame,
  encodeFrame,
  encodeWindow,
  FrameType,
  parseControlMessage,
  type FrameType as FrameTypeValue,
} from "./frames";
import {
  isPublicAddress,
  parseIPv4,
  parseIPv6,
  resolvePublicAddress,
  type Nat64Prefix,
} from "./ip-policy";
import { INITIAL_WINDOW, MAX_FRAME_PAYLOAD, MAX_IN_FLIGHT, Mux } from "./mux";

const hex = (buffer: Buffer) => buffer.toString("hex");

/* ------------------------------------------------------------------------------------ frames */

function frameVectors() {
  const cases: { type: FrameTypeValue; streamId: number; payload: Buffer }[] = [
    {
      type: FrameType.Open,
      streamId: 1,
      payload: Buffer.from('{"host":"example.com","port":443}'),
    },
    { type: FrameType.OpenOk, streamId: 1, payload: Buffer.alloc(0) },
    { type: FrameType.OpenFail, streamId: 3, payload: Buffer.from("Connection refused") },
    { type: FrameType.OpenFail, streamId: 5, payload: Buffer.from(AGENT_GONE) },
    { type: FrameType.Data, streamId: 0, payload: Buffer.from([0, 1, 2, 255]) },
    { type: FrameType.Data, streamId: 0xffffffff, payload: Buffer.alloc(0) },
    { type: FrameType.End, streamId: 7, payload: Buffer.alloc(0) },
    { type: FrameType.Reset, streamId: 0x01020304, payload: Buffer.alloc(0) },
    { type: FrameType.Window, streamId: 9, payload: encodeWindow(9, 65536).subarray(5) },
  ];
  const valid = cases.map(({ type, streamId, payload }) => ({
    type,
    streamId,
    payload: hex(payload),
    encoded: hex(encodeFrame(type, streamId, payload)),
  }));
  // The largest frame, by its fill and a hash, to keep the file small.
  const large = encodeFrame(FrameType.Data, 11, Buffer.alloc(MAX_FRAME_PAYLOAD, 0xab));
  const largest = {
    type: FrameType.Data,
    streamId: 11,
    fill: [MAX_FRAME_PAYLOAD, 0xab],
    encodedLength: large.length,
    encodedSha256: createHash("sha256").update(large).digest("hex"),
  };
  const invalid = ["", "01", "0100000001".slice(0, 8), "0000000001", "0800000001", "ff00000001"]
    .filter((value) => {
      try {
        decodeFrame(Buffer.from(value, "hex"));
        return false;
      } catch {
        return true;
      }
    })
    .map((encoded) => ({ encoded }));
  return { valid, largest, invalid };
}

/* ------------------------------------------------------------------------------ control */

function controlVectors() {
  const texts = [
    '{"type":"config","mode":"prefer","agentOnline":true}',
    '{"type":"config","mode":"require","agentOnline":false,"wakeable":true,"holdMs":20000}',
    '{"type":"demand","screenId":"0b6c6a3e-6f1b-4c4b-9a43-7d2f0f9b1a11"}',
    '{"type":"peer-down"}',
    '{"type":"peer-up","extra":1}',
    '{"type":"role","role":"active"}',
    '{"type":"role","role":"standby"}',
    '{"type":"role","role":"release"}',
    '{"type":"policy","phoneMode":"always"}',
    '{"type":"stats","openStreams":3,"bytesIn":1024,"bytesOut":2048}',
    '{"type":"unavailable","reason":"wifi-only"}',
    '{"type":"unavailable","reason":"low-power-standby"}',
    '{"type":"unavailable","reason":"data-cap","seq":7}',
    '{"type":"available","seq":0}',
    '{"type":"available","seq":7}',
    // Malformed or unknown: each parses to null.
    "",
    "not json",
    "[]",
    "null",
    '{"type":"config","mode":"sometimes","agentOnline":true}',
    '{"type":"config","mode":"off","agentOnline":"yes"}',
    '{"type":"config","mode":"off","agentOnline":false,"holdMs":-1}',
    '{"type":"config","mode":"off","agentOnline":false,"holdMs":1.5}',
    '{"type":"role","role":"boss"}',
    '{"type":"policy","phoneMode":"sometimes"}',
    '{"type":"stats","openStreams":-1,"bytesIn":0,"bytesOut":0}',
    '{"type":"unavailable","reason":"tired"}',
    '{"type":"unavailable","reason":"stopped","seq":-1}',
    '{"type":"available"}',
    '{"type":"available","seq":"7"}',
    '{"type":"demand","screenId":""}',
    '{"type":"hello"}',
    '{"kind":"config"}',
  ];
  return texts.map((text) => ({ text, parsed: parseControlMessage(text) }));
}

/* ----------------------------------------------------------------------------- ip policy */

/** RFC 6052's example prefixes, one per length. */
export const RFC6052_PREFIXES: Nat64Prefix[] = [
  { prefix: "2001:db8::", length: 32 },
  { prefix: "2001:db8:100::", length: 40 },
  { prefix: "2001:db8:122::", length: 48 },
  { prefix: "2001:db8:122:300::", length: 56 },
  { prefix: "2001:db8:122:344::", length: 64 },
  { prefix: "2001:db8:122:344::", length: 96 },
];

/** Put an IPv4 address into a NAT64 prefix as RFC 6052 does, written in full. */
export function embedIPv4({ prefix, length }: Nat64Prefix, v4: string): string {
  const bytes = parseIPv6(prefix)!.map((byte, index) => (index < length / 8 ? byte : 0));
  const layout = {
    32: [4, 5, 6, 7],
    40: [5, 6, 7, 9],
    48: [6, 7, 9, 10],
    56: [7, 9, 10, 11],
    64: [9, 10, 11, 12],
    96: [12, 13, 14, 15],
  }[length];
  parseIPv4(v4)!.forEach((byte, index) => (bytes[layout[index]!] = byte));
  const groups = [];
  for (let index = 0; index < 16; index += 2)
    groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  return groups.join(":");
}

async function ipPolicyVectors() {
  const operatorPrefix: Nat64Prefix = { prefix: "2001:db8:64::", length: 96 };
  const prefixes = RFC6052_PREFIXES;
  const addresses: { address: string; nat64?: Nat64Prefix[] }[] = [
    ...[
      "8.8.8.8",
      "93.184.215.14",
      "1.1.1.1",
      "0.0.0.0",
      "10.1.2.3",
      "100.64.1.1",
      "100.128.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.15.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "172.32.0.1",
      "192.0.0.8",
      "192.0.1.1",
      "192.168.1.10",
      "198.18.0.1",
      "198.20.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::",
      "::1",
      "::127.0.0.1",
      "::8.8.8.8",
      "::ffff:192.168.1.1",
      "::ffff:8.8.8.8",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::FFFF:C0A8:0101",
      "64:ff9b::a00:1",
      "64:ff9b::808:808",
      "64:ff9b::8.8.8.8",
      "64:ff9b::10.0.0.1",
      "64:ff9b:1::808:808",
      "2002:c0a8:101::1",
      "2002:808:808::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:db8::1",
      "100::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "febf::1",
      "fec0::1",
      "ff02::1",
      "fe80::1%en0",
      // Not IP literals at all: refused.
      "example.com",
      "1.2.3",
      "1.2.3.4.5",
      "01.2.3.4",
      "256.1.1.1",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "1:2:3:4:5:6:7::8:9",
      "1:2:3:4:5:6:7:8::",
      "12345::1",
      "",
    ].map((address) => ({ address })),
    // A network's own NAT64 prefix: the IPv4 address inside decides.
    { address: "2001:db8:64::a00:1", nat64: [operatorPrefix] },
    { address: "2001:db8:64::808:808", nat64: [operatorPrefix] },
    { address: "2001:db8:64::a00:1" },
    // Every RFC 6052 layout, with a private and a public IPv4 address inside.
    ...prefixes.flatMap((prefix) =>
      ["10.0.0.1", "192.168.1.1", "8.8.8.8", "93.184.215.14"].map((v4) => ({
        address: embedIPv4(prefix, v4),
        nat64: [prefix],
      })),
    ),
  ];
  const policy = addresses.map(({ address, nat64 }) => ({
    address,
    ...(nat64 ? { nat64 } : {}),
    public: isPublicAddress(address, nat64 ? { nat64 } : {}),
  }));

  const resolutions: {
    host: string;
    answers: { address: string; family: number }[];
    nat64?: Nat64Prefix[];
  }[] = [
    { host: "example.com", answers: [{ address: "93.184.215.14", family: 4 }] },
    {
      host: "dual.example",
      answers: [
        { address: "2606:2800:220:1::1", family: 6 },
        { address: "93.184.215.14", family: 4 },
      ],
    },
    { host: "v6only.example", answers: [{ address: "2606:2800:220:1::1", family: 6 }] },
    {
      host: "mixed.example",
      answers: [
        { address: "93.184.215.14", family: 4 },
        { address: "192.168.0.1", family: 4 },
      ],
    },
    { host: "rebind.example", answers: [{ address: "127.0.0.1", family: 4 }] },
    {
      host: "dns64.example",
      answers: [{ address: "2001:db8:64::a00:1", family: 6 }],
      nat64: [operatorPrefix],
    },
    { host: "empty.example", answers: [] },
    { host: "8.8.8.8", answers: [] },
    { host: "[2606:4700:4700::1111]", answers: [] },
    { host: "[::1]", answers: [] },
    { host: "10.0.0.1", answers: [] },
  ];
  const resolved = await Promise.all(
    resolutions.map(async ({ host, answers, nat64 }) => {
      try {
        const address = await resolvePublicAddress(
          host,
          async () => answers,
          nat64 ? { nat64 } : {},
        );
        return { host, answers, ...(nat64 ? { nat64 } : {}), result: address };
      } catch (error) {
        return {
          host,
          answers,
          ...(nat64 ? { nat64 } : {}),
          error:
            error instanceof Error && error.name === "BlockedDestinationError"
              ? "blocked"
              : "unresolved",
        };
      }
    }),
  );
  return { policy, resolutions: resolved };
}

/* ---------------------------------------------------------------------------- mux scenarios */

/** A destination socket the scenario controls: it records what the mux does to it. */
class FakeSocket extends EventEmitter {
  writes: Buffer[] = [];
  private callbacks: (() => void)[] = [];
  ended = false;
  destroyed = false;
  paused = false;

  write(chunk: Buffer, callback?: () => void): boolean {
    this.writes.push(Buffer.from(chunk));
    if (callback) this.callbacks.push(callback);
    return true;
  }
  /** Finish the writes so far (the mux credits the other side as each finishes). */
  flush(): void {
    for (const callback of this.callbacks.splice(0)) callback();
  }
  end(): this {
    this.ended = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  isPaused(): boolean {
    return this.paused;
  }
  setNoDelay(): this {
    return this;
  }
}

/** One step of a scenario. Data is a hex string, or `fill` bytes of a repeated value. */
export type ScenarioOp =
  | {
      op: "frame";
      type: FrameTypeValue;
      streamId: number;
      payload?: string;
      fill?: [number, number];
    }
  | { op: "connect-ok" }
  | { op: "connect-fail"; reason: string }
  | { op: "socket-data"; socket: number; payload?: string; fill?: [number, number] }
  | { op: "socket-end"; socket: number }
  | { op: "socket-close"; socket: number; hadError: boolean }
  | { op: "socket-error"; socket: number }
  | { op: "socket-flush"; socket: number }
  | { op: "reset-all" };

/** A frame the mux sent, with small payloads in full and large ones by length and hash. */
interface RecordedFrame {
  type: FrameTypeValue;
  streamId: number;
  payload?: string;
  length?: number;
  sha256?: string;
}

interface RecordedSocket {
  /** Bytes written to it during this step, concatenated. */
  written: string | { length: number; sha256: string };
  ended: boolean;
  destroyed: boolean;
  paused: boolean;
}

const SMALL = 64;

function recordFrame(data: Buffer): RecordedFrame {
  const frame = decodeFrame(data);
  return frame.payload.length <= SMALL
    ? { type: frame.type, streamId: frame.streamId, payload: hex(frame.payload) }
    : {
        type: frame.type,
        streamId: frame.streamId,
        length: frame.payload.length,
        sha256: createHash("sha256").update(frame.payload).digest("hex"),
      };
}

function bytesOf(step: { payload?: string; fill?: [number, number] }): Buffer {
  if (step.fill) return Buffer.alloc(step.fill[0], step.fill[1]);
  return Buffer.from(step.payload ?? "", "hex");
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function runScenario(name: string, ops: ScenarioOp[]) {
  const sent: Buffer[] = [];
  const sockets: FakeSocket[] = [];
  const pendingConnects: { resolve: (socket: Socket) => void; reject: (error: Error) => void }[] =
    [];
  const mux = new Mux({
    role: "agent",
    send: (frame) => sent.push(Buffer.from(frame)),
    connect: () =>
      new Promise<Socket>((resolve, reject) => pendingConnects.push({ resolve, reject })),
  });
  const steps = [];
  for (const step of ops) {
    const writtenBefore = sockets.map((socket) => socket.writes.length);
    switch (step.op) {
      case "frame":
        mux.handleFrame(encodeFrame(step.type, step.streamId, bytesOf(step)));
        break;
      case "connect-ok": {
        const socket = new FakeSocket();
        sockets.push(socket);
        pendingConnects.shift()!.resolve(socket as unknown as Socket);
        break;
      }
      case "connect-fail":
        pendingConnects.shift()!.reject(new Error(step.reason));
        break;
      case "socket-data":
        sockets[step.socket]!.emit("data", bytesOf(step));
        break;
      case "socket-end":
        sockets[step.socket]!.emit("end");
        break;
      case "socket-close":
        sockets[step.socket]!.emit("close", step.hadError);
        break;
      case "socket-error":
        sockets[step.socket]!.emit("error", new Error("boom"));
        break;
      case "socket-flush":
        sockets[step.socket]!.flush();
        break;
      case "reset-all":
        mux.resetAll();
        break;
    }
    await tick();
    await tick();
    const recordedSockets: RecordedSocket[] = sockets.map((socket, index) => {
      const written = Buffer.concat(socket.writes.slice(writtenBefore[index] ?? 0));
      return {
        written:
          written.length <= SMALL
            ? hex(written)
            : {
                length: written.length,
                sha256: createHash("sha256").update(written).digest("hex"),
              },
        ended: socket.ended,
        destroyed: socket.destroyed,
        paused: socket.paused,
      };
    });
    steps.push({
      ...step,
      expect: {
        frames: sent.splice(0).map(recordFrame),
        sockets: recordedSockets,
        openStreams: mux.stats.openStreams,
        uncredited: mux.uncredited,
      },
    });
  }
  return { name, steps };
}

const open = (streamId: number, host = "93.184.215.14", port = 443): ScenarioOp => ({
  op: "frame",
  type: FrameType.Open,
  streamId,
  payload: hex(Buffer.from(JSON.stringify({ host, port }))),
});
const frame = (type: FrameTypeValue, streamId: number, payload = ""): ScenarioOp => ({
  op: "frame",
  type,
  streamId,
  payload,
});
const window = (streamId: number, bytes: number): ScenarioOp =>
  frame(FrameType.Window, streamId, hex(encodeWindow(streamId, bytes).subarray(5)));
const text = (value: string) => hex(Buffer.from(value));

async function muxScenarios() {
  const chunk = MAX_FRAME_PAYLOAD;
  /** Enough data from one destination to use up its stream's whole window. */
  const fillWindow = (socket: number): ScenarioOp[] =>
    Array.from({ length: INITIAL_WINDOW / chunk }, () => ({
      op: "socket-data" as const,
      socket,
      fill: [chunk, socket + 1] as [number, number],
    }));
  const scenarios: [string, ScenarioOp[]][] = [
    [
      "open, exchange data and credit",
      [
        open(1),
        { op: "connect-ok" },
        { op: "socket-data", socket: 0, payload: text("hello") },
        frame(FrameType.Data, 1, text("GET / HTTP/1.1")),
        { op: "socket-flush", socket: 0 },
        window(1, 5),
      ],
    ],
    ["open fails", [open(1), { op: "connect-fail", reason: "Connection refused" }]],
    ["malformed open", [frame(FrameType.Open, 1, text("{not json"))]],
    ["open with a missing port", [frame(FrameType.Open, 1, text('{"host":"example.com"}'))]],
    ["duplicate open while connecting", [open(1), open(1), { op: "connect-ok" }]],
    [
      "destination ends first, then the other side",
      [
        open(1),
        { op: "connect-ok" },
        { op: "socket-end", socket: 0 },
        frame(FrameType.End, 1),
        { op: "socket-close", socket: 0, hadError: false },
      ],
    ],
    [
      "the other side ends first, then the destination",
      [
        open(1),
        { op: "connect-ok" },
        frame(FrameType.End, 1),
        { op: "socket-data", socket: 0, payload: text("bye") },
        { op: "socket-end", socket: 0 },
        { op: "socket-close", socket: 0, hadError: false },
      ],
    ],
    [
      "data before end is still delivered",
      [
        open(1),
        { op: "connect-ok" },
        frame(FrameType.Data, 1, text("last words")),
        frame(FrameType.End, 1),
        { op: "socket-flush", socket: 0 },
      ],
    ],
    ["reset while open", [open(1), { op: "connect-ok" }, frame(FrameType.Reset, 1)]],
    ["reset while connecting", [open(1), frame(FrameType.Reset, 1), { op: "connect-ok" }]],
    [
      "a failure for a replaced stream is not reported",
      [
        open(1),
        frame(FrameType.Reset, 1),
        open(1),
        { op: "connect-fail", reason: "late failure of the first" },
        { op: "connect-ok" },
      ],
    ],
    ["destination error", [open(1), { op: "connect-ok" }, { op: "socket-error", socket: 0 }]],
    [
      "destination closes with an error",
      [open(1), { op: "connect-ok" }, { op: "socket-close", socket: 0, hadError: true }],
    ],
    ["data for an unknown stream", [frame(FrameType.Data, 9, text("stray"))]],
    ["end and window for an unknown stream", [frame(FrameType.End, 9), window(9, 10)]],
    [
      "a large chunk is split into frames",
      [open(1), { op: "connect-ok" }, { op: "socket-data", socket: 0, fill: [chunk * 2 + 100, 7] }],
    ],
    [
      "window exhaustion pauses and credit resumes",
      [
        open(1),
        { op: "connect-ok" },
        ...fillWindow(0),
        window(1, chunk),
        window(1, INITIAL_WINDOW),
      ],
    ],
    [
      "too much in flight across streams pauses every stream",
      [
        ...Array.from({ length: MAX_IN_FLIGHT / INITIAL_WINDOW + 1 }, (_, index) => [
          open(index * 2 + 1),
          { op: "connect-ok" } as ScenarioOp,
        ]).flat(),
        ...Array.from({ length: MAX_IN_FLIGHT / INITIAL_WINDOW }, (_, socket) =>
          Array.from({ length: INITIAL_WINDOW / chunk / 2 }, () => ({
            op: "socket-data" as const,
            socket,
            fill: [chunk * 2, socket + 1] as [number, number],
          })),
        ).flat(),
        { op: "socket-data", socket: MAX_IN_FLIGHT / INITIAL_WINDOW, fill: [chunk, 9] },
        window(1, INITIAL_WINDOW),
      ],
    ],
    [
      "a closed stream's uncredited data is released",
      [
        open(1),
        { op: "connect-ok" },
        { op: "socket-data", socket: 0, fill: [chunk, 1] },
        frame(FrameType.Reset, 1),
      ],
    ],
    [
      "reset all",
      [open(1), { op: "connect-ok" }, open(3), { op: "reset-all" }, { op: "connect-ok" }],
    ],
  ];
  const results = [];
  for (const [name, ops] of scenarios) results.push(await runScenario(name, ops));
  return results;
}

/** Every vector file, by name. */
export async function buildVectors(): Promise<Record<string, unknown>> {
  return {
    "frames.json": {
      constants: {
        initialWindow: INITIAL_WINDOW,
        maxFramePayload: MAX_FRAME_PAYLOAD,
        maxInFlight: MAX_IN_FLIGHT,
        agentGone: AGENT_GONE,
      },
      // Every wire value of each control message enum, in order, so the Kotlin enums can't drift.
      enums: {
        egressMode: EGRESS_MODES,
        phoneMode: PHONE_MODES,
        agentRole: AGENT_ROLES,
        unavailableReason: UNAVAILABLE_REASONS,
      },
      ...frameVectors(),
    },
    "control.json": controlVectors(),
    "ip-policy.json": await ipPolicyVectors(),
    "mux-scenarios.json": await muxScenarios(),
  };
}
