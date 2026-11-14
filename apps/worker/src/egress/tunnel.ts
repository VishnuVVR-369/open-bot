// The tunnel's frames and sockets: the computer's socket, each stream's ids translated between the
// computer and the agent carrying it, and heartbeats. The relay's state is passed in as `relay`.
import {
  AGENT_GONE,
  encodeFrame,
  FrameType,
  parseControlMessage,
  type ControlMessage,
} from "@open-bot/egress";
import type { EgressMode } from "@open-bot/domain";
import WebSocket from "ws";
import {
  CLOSE_REPLACED,
  type Agent,
  type RelayHooks,
  type RelayOptions,
  type RelayTimings,
  type Route,
} from "./relay-types";

/** An agent whose socket holds more than this is too slow or stuck, and is dropped. */
export const MAX_AGENT_BUFFER = 32 * 1024 * 1024;
const HEADER_BYTES = 5;
const MAX_STREAM_ID = 0xffff_ffff;

/** The relay's state and callbacks the tunnel uses; `EgressRelay` is the only one. */
export interface TunnelRelay {
  readonly options: RelayOptions;
  readonly timings: RelayTimings;
  readonly hooks: RelayHooks;
  readonly stopped: boolean;
  readonly computerPaused: boolean;
  readonly computerGeneration: number;
  computer: WebSocket | null;
  openingComputer: WebSocket | null;
  computerMissedPongs: number;
  computerTimer: NodeJS.Timeout | null;
  readonly routes: Map<number, Route>;
  readonly agents: Map<string, Agent>;
  readonly active: Agent | null;
  readonly mode: EgressMode;
  detach(agent: Agent): void;
  releaseIfDrained(agent: Agent): void;
  changed(): void;
}

/* --------------------------------------------------------------- streams */

/** End a stream its agent won't carry: one still opening may be routed again. */
export function abandon(relay: TunnelRelay, route: Route): void {
  sendAgent(relay, route.agent, encodeFrame(FrameType.Reset, route.agentId));
  sendComputer(
    relay,
    route.opening
      ? encodeFrame(FrameType.OpenFail, route.computerId, AGENT_GONE)
      : encodeFrame(FrameType.Reset, route.computerId),
  );
  forget(relay, route);
}

export function fromAgent(
  relay: TunnelRelay,
  agent: Agent,
  data: WebSocket.RawData,
  isBinary: boolean,
): void {
  if (agent.detached) return;
  if (!isBinary) {
    const message = parseControlMessage(rawToBuffer(data).toString("utf8"));
    if (message?.type === "stats") {
      agent.stats = {
        openStreams: message.openStreams,
        bytesIn: message.bytesIn,
        bytesOut: message.bytesOut,
      };
    } else if (agent.claim.kind === "phone") {
      phoneControl(relay, agent.claim.id, data);
    }
    return;
  }
  const frame = rawToBuffer(data);
  if (frame.length < HEADER_BYTES) return;
  const type = frame[0];
  const agentId = frame.readUInt32BE(1);
  const route = agent.streams.get(agentId);
  if (!route) {
    // Like TCP, data for a stream that's gone is refused, so the sender stops waiting.
    if (type === FrameType.Data) sendAgent(relay, agent, encodeFrame(FrameType.Reset, agentId));
    return;
  }
  switch (type) {
    case FrameType.OpenOk:
      if (!route.opening) return;
      route.opening = false;
      toComputer(relay, route, frame);
      return;
    case FrameType.OpenFail:
      if (!route.opening) return;
      toComputer(relay, route, frame);
      forget(relay, route);
      return;
    case FrameType.Data:
    case FrameType.Window:
      if (route.opening) return;
      toComputer(relay, route, frame);
      return;
    case FrameType.End:
      if (route.opening || route.agentEnded) return;
      route.agentEnded = true;
      toComputer(relay, route, frame);
      if (route.computerEnded) forget(relay, route);
      return;
    case FrameType.Reset:
      toComputer(relay, route, frame);
      forget(relay, route);
      return;
    default:
      // Agents never open streams.
      return;
  }
}

/** A phone's own control messages: that it is back, or why it's about to leave. */
export function phoneControl(relay: TunnelRelay, phoneId: string, data: WebSocket.RawData): void {
  const message = parseControlMessage(rawToBuffer(data).toString("utf8"));
  if (message?.type === "unavailable")
    relay.hooks.onUnavailable?.(phoneId, message.reason, message.seq);
  else if (message?.type === "available") relay.hooks.onAvailable?.(phoneId, message.seq);
}

function toComputer(relay: TunnelRelay, route: Route, frame: Buffer): void {
  frame.writeUInt32BE(route.computerId, 1);
  sendComputer(relay, frame);
}

function toAgent(relay: TunnelRelay, route: Route, frame: Buffer): void {
  frame.writeUInt32BE(route.agentId, 1);
  sendAgent(relay, route.agent, frame);
}

/** Stop tracking a finished stream; a standby phone with nothing left may then go. */
function forget(relay: TunnelRelay, route: Route): void {
  if (relay.routes.get(route.computerId) === route) relay.routes.delete(route.computerId);
  route.agent.streams.delete(route.agentId);
  if (route.agent.role === "standby") relay.releaseIfDrained(route.agent);
}

function sendAgent(relay: TunnelRelay, agent: Agent, data: Buffer): void {
  const socket = agent.socket;
  if (agent.detached || socket.readyState !== WebSocket.OPEN) return;
  socket.send(data, { binary: true });
  if (socket.bufferedAmount > MAX_AGENT_BUFFER) {
    relay.options.log.warn("egress agent too slow, dropping it", { name: agent.claim.name });
    socket.terminate();
    relay.detach(agent);
  }
}

export function sendText(relay: TunnelRelay, agent: Agent, message: ControlMessage): void {
  if (!agent.detached && agent.socket.readyState === WebSocket.OPEN)
    agent.socket.send(JSON.stringify(message));
}

/* -------------------------------------------------------------- computer */

export function connectComputer(relay: TunnelRelay): void {
  if (relay.stopped || relay.computerPaused || relay.openingComputer || relay.computer) return;
  const generation = relay.computerGeneration;
  const socket = new WebSocket(relay.options.computerUrl(), {
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  relay.openingComputer = socket;
  socket.on("open", () => {
    if (relay.stopped || relay.computerPaused || generation !== relay.computerGeneration) {
      socket.terminate();
      return;
    }
    relay.openingComputer = null;
    relay.computer = socket;
    relay.computerMissedPongs = 0;
    // `config` is always the first message on a tunnel connection.
    sendConfig(relay);
    for (const agent of relay.agents.values()) sendText(relay, agent, { type: "peer-up" });
    relay.changed();
  });
  socket.on("message", (data, isBinary) => {
    if (relay.computer !== socket) return;
    if (isBinary) {
      fromComputer(relay, rawToBuffer(data));
      return;
    }
    const message = parseControlMessage(rawToBuffer(data).toString("utf8"));
    if (message?.type === "demand") relay.hooks.onDemand?.(message.screenId);
  });
  socket.on("pong", () => {
    if (relay.computer === socket) relay.computerMissedPongs = 0;
  });
  socket.on("close", () => {
    if (relay.openingComputer === socket) relay.openingComputer = null;
    if (generation !== relay.computerGeneration) return;
    if (relay.computer === socket) {
      relay.computer = null;
      dropComputerStreams(relay);
      relay.changed();
    }
    if (!relay.stopped && !relay.computerPaused)
      relay.computerTimer = setTimeout(() => {
        relay.computerTimer = null;
        if (generation === relay.computerGeneration) connectComputer(relay);
      }, relay.timings.computerRetryMs);
  });
  socket.on("error", () => {});
}

/** The computer side went away: every stream is gone, and agents drop theirs. */
export function dropComputerStreams(relay: TunnelRelay): void {
  for (const route of relay.routes.values()) route.agent.streams.delete(route.agentId);
  relay.routes.clear();
  for (const agent of [...relay.agents.values()]) {
    sendText(relay, agent, { type: "peer-down" });
    if (agent.role === "standby") relay.releaseIfDrained(agent);
  }
}

function fromComputer(relay: TunnelRelay, frame: Buffer): void {
  if (frame.length < HEADER_BYTES) return;
  const type = frame[0];
  const computerId = frame.readUInt32BE(1);
  if (type === FrameType.Open) {
    open(relay, computerId, frame);
    return;
  }
  const route = relay.routes.get(computerId);
  if (!route) {
    if (type === FrameType.Data) sendComputer(relay, encodeFrame(FrameType.Reset, computerId));
    return;
  }
  switch (type) {
    case FrameType.Data:
    case FrameType.Window:
      toAgent(relay, route, frame);
      return;
    case FrameType.End:
      if (route.computerEnded) return;
      route.computerEnded = true;
      toAgent(relay, route, frame);
      if (route.agentEnded) forget(relay, route);
      return;
    case FrameType.Reset:
      toAgent(relay, route, frame);
      forget(relay, route);
      return;
    default:
      return;
  }
}

function open(relay: TunnelRelay, computerId: number, frame: Buffer): void {
  if (relay.routes.has(computerId)) {
    sendComputer(relay, encodeFrame(FrameType.OpenFail, computerId, "Stream id already in use"));
    return;
  }
  let agent = relay.active;
  if (agent && agent.nextId > MAX_STREAM_ID) {
    // Billions of streams on one connection: start the agent over rather than reuse an id.
    agent.socket.close(CLOSE_REPLACED, "Out of stream ids");
    relay.detach(agent);
    agent = relay.active;
  }
  if (!agent) {
    sendComputer(relay, encodeFrame(FrameType.OpenFail, computerId, AGENT_GONE));
    return;
  }
  const route: Route = {
    computerId,
    agent,
    agentId: agent.nextId,
    opening: true,
    computerEnded: false,
    agentEnded: false,
  };
  agent.nextId += 2;
  relay.routes.set(computerId, route);
  agent.streams.set(route.agentId, route);
  toAgent(relay, route, frame);
}

export function sendComputer(relay: TunnelRelay, data: Buffer | string): void {
  const socket = relay.computer;
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(data, { binary: typeof data !== "string" });
}

export function sendConfig(relay: TunnelRelay): void {
  const message: ControlMessage = {
    type: "config",
    mode: relay.mode,
    agentOnline: relay.active !== null,
    ...relay.hooks.configExtras?.(),
  };
  sendComputer(relay, JSON.stringify(message));
}

/* ------------------------------------------------------------ heartbeats */

export function heartbeat(relay: TunnelRelay): void {
  for (const agent of [...relay.agents.values()]) {
    if (agent.missedPongs >= 2) {
      relay.options.log.warn("egress agent stopped answering", { name: agent.claim.name });
      agent.socket.terminate();
      relay.detach(agent);
      continue;
    }
    agent.missedPongs += 1;
    if (agent.socket.readyState === WebSocket.OPEN) agent.socket.ping();
  }
  const computer = relay.computer;
  if (computer?.readyState === WebSocket.OPEN) {
    if (relay.computerMissedPongs >= 2) {
      relay.options.log.warn("the computer's egress tunnel stopped answering");
      computer.terminate();
      return;
    }
    relay.computerMissedPongs += 1;
    computer.ping();
  }
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
