import type http from "node:http";
import { BOTD_SOCKETS } from "@open-bot/api/botd";
import { isOwnerLease, isScreenId } from "@open-bot/domain";
import { LEGACY_DESKTOP_AGENT, readToken, verifyToken } from "@open-bot/domain/server";
import WebSocket, { WebSocketServer } from "ws";
import type { Context } from "./context";
import { egressAgentClaimSchema } from "./egress/claims";
import type { EgressRelay } from "./egress/relay";

/**
 * The worker's WebSockets, which the web app's signed tokens open: `/vnc` proxies a browser's
 * noVNC connection to a screen, and `/egress/agent` is the desktop app's or a phone's tunnel.
 */
export function handleUpgrades(server: http.Server, ctx: Context, egress: EgressRelay): void {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://worker");
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname === "/vnc") {
      const mode = url.searchParams.get("mode") === "control" ? "control" : "view";
      const screen = url.searchParams.get("screen");
      if (!verifyToken(token, "vnc", ctx.env.WORKER_SECRET)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      if (!isScreenId(screen)) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      if (
        !ctx.computer.online ||
        !ctx.computer.health?.screens.some((s) => s.id === screen && s.state === "running")
      ) {
        socket.end("HTTP/1.1 409 Conflict\r\n\r\n");
        return;
      }
      if (mode === "control" && !isOwnerLease(ctx.computer.lease(screen))) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => proxyVnc(client, ctx, screen, mode));
      return;
    }
    if (url.pathname === "/egress/agent") {
      const claims = readToken(token, "egress", ctx.env.WORKER_SECRET);
      // Tokens from a web server older than phone egress name no device: the desktop app.
      const agent = egressAgentClaimSchema.safeParse(claims?.agent ?? LEGACY_DESKTOP_AGENT);
      if (!claims || !agent.success) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        void egress.attachAgent(client, agent.data);
      });
      return;
    }
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
}
/** Proxy a browser's noVNC connection to a screen's view-only or control VNC server. */
function proxyVnc(client: WebSocket, ctx: Context, screen: string, mode: "view" | "control") {
  const upstream = new WebSocket(ctx.computer.wsUrl(BOTD_SOCKETS.vnc, { screen, mode }), {
    perMessageDeflate: false,
  });
  const pending: Buffer[] = [];
  upstream.on("open", () => {
    for (const chunk of pending) upstream.send(chunk);
    pending.length = 0;
  });
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
  });
  upstream.on("close", (code, reason) => {
    const forwardable = code === 1000 || (code >= 3000 && code <= 4999);
    client.close(forwardable ? code : 1011, reason);
  });
  upstream.on("error", () => client.close(1011, "The computer's desktop is not reachable"));
  client.on("message", (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(chunk);
    else pending.push(chunk);
  });
  client.on("close", () => upstream.close());
}
