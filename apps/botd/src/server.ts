import { randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { BOTD_SOCKETS, botdContract } from "@open-bot/api/botd";
import {
  isOwnerLease,
  isScreenId,
  type ComputerEvent,
  type ComputerHealth,
} from "@open-bot/domain";
import { WebSocket, WebSocketServer } from "ws";
import type { ComputeLifecycle } from "./lifecycle";
import type { EgressRouter } from "@open-bot/egress/router";
import type { PageChecker } from "./pages";
import { createRouter } from "./router";
import { createRpcHandler } from "./rpc";
import type { ScreenManager } from "./screens";

export interface ServerDeps {
  token: string;
  lifecycle?: ComputeLifecycle;
  screens: ScreenManager;
  egress: EgressRouter;
  health: () => ComputerHealth;
  codexUrl: string;
  pages: PageChecker;
  log: (message: string) => void;
}

/** The one path that needs no token: Railway's health check calls it. */
const HEALTHZ_PATH = botdContract.healthz["~orpc"].route.path;

function authorized(request: IncomingMessage, token: string): boolean {
  const url = new URL(request.url ?? "/", "http://botd");
  const header = request.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createServer(deps: ServerDeps): {
  server: http.Server;
  broadcastHealth: () => void;
} {
  const { screens } = deps;
  const eventClients = new Set<WebSocket>();
  /** Your control connections, by screen. */
  const controlBridges = new Map<string, Set<WebSocket>>();

  const broadcast = (event: ComputerEvent) => {
    const message = JSON.stringify(event);
    for (const client of eventClients)
      if (client.readyState === WebSocket.OPEN) client.send(message);
  };

  screens.on("lease", (screenId, { holder, reason }) => {
    broadcast({ type: "lease", screenId, holder, reason });
    // Control connections only live while you hold the screen.
    if (!isOwnerLease(holder) || screens.get(screenId)?.lease.inputBlocked) {
      for (const bridge of controlBridges.get(screenId) ?? [])
        bridge.close(4001, "Control returned to the teammate");
      controlBridges.delete(screenId);
    }
  });
  screens.on("changed", () => broadcast({ type: "health", health: deps.health() }));
  setInterval(() => broadcast({ type: "health", health: deps.health() }), 5_000).unref();

  const rpc = createRpcHandler(createRouter(deps), deps);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://botd");
    // Only the liveness check is open: Railway's health check has no token.
    if (url.pathname !== HEALTHZ_PATH && !authorized(request, deps.token)) {
      send(response, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
      return;
    }
    try {
      const { matched } = await rpc.handle(request, response, { context: {} });
      if (!matched) send(response, 404, { error: "not found", code: "NOT_FOUND" });
    } catch (error) {
      deps.log(`[http] ${request.method} ${url.pathname} failed: ${String(error)}`);
      if (!response.headersSent)
        send(response, 500, { error: "botd failed", code: "INTERNAL_SERVER_ERROR" });
      else response.destroy();
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://botd");
    if (!authorized(request, deps.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (deps.lifecycle && !deps.lifecycle.admitting) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    if (url.pathname === BOTD_SOCKETS.vnc) {
      void upgradeVnc(request, socket, head, url);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      switch (url.pathname) {
        case BOTD_SOCKETS.events:
          eventClients.add(ws);
          for (const screen of screens.list())
            ws.send(
              JSON.stringify({
                type: "lease",
                screenId: screen.id,
                holder: screen.lease,
              } satisfies ComputerEvent),
            );
          ws.send(
            JSON.stringify({ type: "health", health: deps.health() } satisfies ComputerEvent),
          );
          ws.on("close", () => eventClients.delete(ws));
          return;
        case BOTD_SOCKETS.codex:
          bridgeWebSocket(ws, deps.codexUrl, deps.log, deps.lifecycle);
          return;
        case BOTD_SOCKETS.egress:
          deps.egress.attachTunnel(ws);
          return;
        default:
          ws.close(4004, "Unknown endpoint");
      }
    });
  });

  /** Watch or control one screen. Watching never starts a screen, so an open tab doesn't keep one running. */
  async function upgradeVnc(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
    url: URL,
  ) {
    const screenId = url.searchParams.get("screen");
    const control = url.searchParams.get("mode") === "control";
    if (!isScreenId(screenId)) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const screen = screens.get(screenId);
    if (!screen) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (control && (!isOwnerLease(screen.lease.holder) || screen.lease.inputBlocked)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connectionId = randomUUID();
      screen.viewers += 1;
      bridgeTcp(ws, control ? screen.vncPorts.control : screen.vncPorts.view, deps.log);
      if (control) {
        const bridges = controlBridges.get(screenId) ?? new Set<WebSocket>();
        controlBridges.set(screenId, bridges);
        bridges.add(ws);
        screen.lease.userConnected(connectionId);
      }
      ws.on("close", () => {
        screen.viewers -= 1;
        if (control) {
          controlBridges.get(screenId)?.delete(ws);
          screen.lease.userDisconnected(connectionId);
        }
      });
    });
  }

  return { server, broadcastHealth: () => broadcast({ type: "health", health: deps.health() }) };
}

/** Pipe a websocket to a raw TCP port (used for VNC, which noVNC speaks over websockets). */
function bridgeTcp(ws: WebSocket, port: number, log: (message: string) => void) {
  const tcp = net.connect(port, "127.0.0.1");
  tcp.setNoDelay(true);
  const pending: Buffer[] = [];
  let connected = false;
  tcp.on("connect", () => {
    connected = true;
    for (const chunk of pending) tcp.write(chunk);
    pending.length = 0;
  });
  tcp.on("data", (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  tcp.on("error", (error) => log(`[vnc] ${String(error)}`));
  tcp.on("close", () => ws.close());
  ws.on("message", (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (connected) tcp.write(chunk);
    else pending.push(chunk);
  });
  ws.on("close", () => tcp.destroy());
}

/** Pipe a websocket to another websocket (used for the Codex app-server). */
function bridgeWebSocket(
  client: WebSocket,
  target: string,
  log: (message: string) => void,
  lifecycle?: ComputeLifecycle,
) {
  const connection = randomUUID();
  const upstream = new WebSocket(target, {
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });
  const pending: { data: WebSocket.RawData; isBinary: boolean }[] = [];
  upstream.on("open", () => {
    if (client.readyState !== WebSocket.OPEN) {
      pending.length = 0;
      upstream.close();
      return;
    }
    for (const message of pending) {
      lifecycle?.rpc(connection, true, message.data.toString());
      upstream.send(message.data, { binary: message.isBinary });
    }
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    lifecycle?.rpc(connection, false, data.toString());
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    // Only application codes and a normal close may be sent on; anything else becomes 1011.
    const forwardable = code === 1000 || (code >= 3000 && code <= 4999);
    client.close(forwardable ? code : code === 1005 ? 1000 : 1011, reason);
  });
  upstream.on("error", (error) => {
    log(`[codex] ${String(error)}`);
    client.close(1011, "Codex is not reachable");
  });
  client.on("message", (data, isBinary) => {
    if (lifecycle && !lifecycle.admitting) {
      client.close(1013, "Computer is quiescing");
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) {
      lifecycle?.rpc(connection, true, data.toString());
      upstream.send(data, { binary: isBinary });
    } else pending.push({ data, isBinary });
  });
  client.on("close", () => upstream.close());
}
