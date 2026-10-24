import { randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import {
  computerActionSchema,
  domainMatches,
  isScreenId,
  USER_HAS_CONTROL_MESSAGE,
  type ComputerActionError,
  type ComputerActionResult,
  type ComputerEvent,
  type ComputerFillRequest,
  type ComputerFillResult,
  type ComputerHealth,
  type ComputerReadResult,
  type RunIdentity,
} from "@open-bot/shared";
import { WebSocket, WebSocketServer } from "ws";
import { ActionAbortedError, Desktop } from "./desktop";
import type { EgressRouter } from "./egress";
import type { Screen, ScreenManager } from "./screens";

export interface ServerDeps {
  token: string;
  screens: ScreenManager;
  egress: EgressRouter;
  health: () => ComputerHealth;
  codexUrl: string;
  log: (message: string) => void;
}

class BadRequest extends Error {}

function screenIdOf(value: unknown): string {
  if (!isScreenId(value)) throw new BadRequest("A valid screen id is required");
  return value;
}

const MAX_BODY_BYTES = 256 * 1024;

function authorized(request: IncomingMessage, token: string): boolean {
  const url = new URL(request.url ?? "/", "http://botd");
  const header = request.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
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
    if (holder?.kind !== "user") {
      for (const bridge of controlBridges.get(screenId) ?? [])
        bridge.close(4001, "Control returned to the bot");
      controlBridges.delete(screenId);
    }
  });
  screens.on("changed", () => broadcast({ type: "health", health: deps.health() }));
  setInterval(() => broadcast({ type: "health", health: deps.health() }), 5_000).unref();

  /** The run's own screen, once it holds it. */
  async function screenForRun(run: RunIdentity): Promise<Screen | ComputerActionError> {
    // Every bot works on its own screen, and a swarm helper on one of its own.
    const screenId = run.screenId ?? run.botId;
    if (!isScreenId(screenId))
      return { ok: false, code: "invalid_action", message: "Unknown screen" };
    let screen: Screen;
    try {
      screen = await screens.ensure(screenId);
    } catch (error) {
      return {
        ok: false,
        code: "failed",
        message: `Your screen couldn't start: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const acquired = await screen.lease.acquireForRun(run);
    if (acquired === "user_has_control") {
      return { ok: false, code: "user_has_control", message: USER_HAS_CONTROL_MESSAGE };
    }
    if (acquired === "desktop_busy") {
      return {
        ok: false,
        code: "desktop_busy",
        message:
          "You're using your screen in another chat right now. Do other work and try the desktop again later.",
      };
    }
    screens.touch(screen);
    return screen;
  }

  async function performAction(body: unknown): Promise<ComputerActionResult | ComputerActionError> {
    const { run, action: rawAction } = body as { run?: RunIdentity; action?: unknown };
    if (!run?.runId || !isScreenId(run.botId)) {
      return { ok: false, code: "invalid_action", message: "Missing run identity" };
    }
    const parsed = computerActionSchema.safeParse(rawAction);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_action",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      };
    }
    const action = parsed.data;
    const screen = await screenForRun(run);
    if (!("lease" in screen)) return screen;
    const { lease, desktop } = screen;
    try {
      await desktop.perform(action);
      const settle = Desktop.settleMs(action);
      if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
      // Taking over during the action means the bot must not see the screen anymore.
      if (lease.holder?.kind === "user") throw new ActionAbortedError();
      const [image, cursor] = await Promise.all([desktop.screenshot(), desktop.cursor()]);
      const blocked = screen.takeBlocked();
      return {
        ok: true,
        screenshot: image.toString("base64"),
        cursor,
        ...(blocked.length && { blocked }),
      };
    } catch (error) {
      if (error instanceof ActionAbortedError || lease.holder?.kind === "user") {
        return { ok: false, code: "user_has_control", message: USER_HAS_CONTROL_MESSAGE };
      }
      return {
        ok: false,
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The readable content of the page in front on the run's screen. */
  async function performRead(body: unknown): Promise<ComputerReadResult | ComputerActionError> {
    const { run, selector } = body as { run?: RunIdentity; selector?: unknown };
    if (!run?.runId || !isScreenId(run.botId)) {
      return { ok: false, code: "invalid_action", message: "Missing run identity" };
    }
    if (
      selector !== undefined &&
      (typeof selector !== "string" || !selector || selector.length > 500)
    ) {
      return { ok: false, code: "invalid_action", message: "selector must be a CSS selector" };
    }
    const screen = await screenForRun(run);
    if (!("lease" in screen)) return screen;
    try {
      const page = await screen.readPage(selector);
      if (screen.lease.holder?.kind === "user") {
        return { ok: false, code: "user_has_control", message: USER_HAS_CONTROL_MESSAGE };
      }
      if ("error" in page) return { ok: false, code: "failed", message: page.error };
      const blocked = screen.takeBlocked();
      return { ok: true, ...page, ...(blocked.length && { blocked }) };
    } catch (error) {
      return {
        ok: false,
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Type a vault secret into whatever has focus on the run's screen. A login only fills on its own
   * site, so a misleading page can't collect it. Nothing about the secret is logged or returned.
   */
  async function performFill(body: unknown): Promise<ComputerFillResult | ComputerActionError> {
    const { run, secret, site } = body as Partial<ComputerFillRequest>;
    if (!run?.runId || !isScreenId(run.botId)) {
      return { ok: false, code: "invalid_action", message: "Missing run identity" };
    }
    if (typeof secret !== "string" || !secret || secret.length > 500) {
      return { ok: false, code: "invalid_action", message: "Nothing to fill" };
    }
    const screen = await screenForRun(run);
    if (!("lease" in screen)) return screen;
    let pages: string[];
    try {
      pages = await screen.visiblePages();
    } catch {
      pages = [];
    }
    if (site) {
      const hosts = pages.map((page) => {
        try {
          return new URL(page).hostname;
        } catch {
          return "";
        }
      });
      if (hosts.length === 0 || !hosts.every((host) => domainMatches(host, site))) {
        return {
          ok: false,
          code: "wrong_site",
          message:
            hosts.length === 0
              ? `The browser isn't showing a page. Open the ${site} sign-in page first.`
              : `The browser is showing ${hosts.filter(Boolean).join(", ") || "a page without an address"}, not ${site}, so it wasn't filled. Open the ${site} sign-in page and click the field first.`,
        };
      }
    }
    try {
      await screen.desktop.typeSecret(secret);
      if (screen.lease.holder?.kind === "user") throw new ActionAbortedError();
      return { ok: true, pages };
    } catch (error) {
      if (error instanceof ActionAbortedError || screen.lease.holder?.kind === "user") {
        return { ok: false, code: "user_has_control", message: USER_HAS_CONTROL_MESSAGE };
      }
      return { ok: false, code: "failed", message: "Typing it on the screen failed." };
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://botd");
    if (url.pathname === "/healthz") {
      const health = deps.health();
      send(response, health.ok ? 200 : 503, { ok: health.ok });
      return;
    }
    if (!authorized(request, deps.token)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "GET /health":
          send(response, 200, deps.health());
          return;
        case "POST /computer/action":
          send(response, 200, await performAction(await readJson(request)));
          return;
        case "POST /computer/fill":
          send(response, 200, await performFill(await readJson(request)));
          return;
        case "POST /computer/read":
          send(response, 200, await performRead(await readJson(request)));
          return;
        case "POST /screens/start": {
          const { screenId } = (await readJson(request)) as { screenId?: unknown };
          const screen = await screens.ensure(screenIdOf(screenId));
          send(response, 200, screen.status());
          return;
        }
        case "POST /screens/forget": {
          const { screenId } = (await readJson(request)) as { screenId?: unknown };
          await screens.forget(screenIdOf(screenId));
          send(response, 200, { ok: true });
          return;
        }
        case "POST /computer/screenshot": {
          const { screenId } = (await readJson(request)) as { screenId?: unknown };
          const screen = await screens.ensure(screenIdOf(screenId));
          const image = await screen.desktop.screenshot();
          send(response, 200, { screenshot: image.toString("base64") });
          return;
        }
        case "POST /lease/run/release": {
          const { runId } = (await readJson(request)) as { runId?: string };
          send(response, 200, { released: runId ? screens.releaseRun(runId) : false });
          return;
        }
        case "POST /lease/user/take": {
          const { screenId } = (await readJson(request)) as { screenId?: unknown };
          const screen = await screens.ensure(screenIdOf(screenId));
          send(response, 200, { previous: screen.lease.takeByUser(), holder: screen.lease.holder });
          return;
        }
        case "POST /lease/user/release": {
          const { screenId, reason } = (await readJson(request)) as {
            screenId?: unknown;
            reason?: "handed_back" | "user_idle" | "user_disconnected";
          };
          const screen = screens.get(screenIdOf(screenId));
          send(response, 200, {
            released: screen?.lease.releaseByUser(reason ?? "handed_back") ?? false,
          });
          return;
        }
        case "POST /lease/user/touch": {
          const { screenId } = (await readJson(request)) as { screenId?: unknown };
          const screen = screens.get(screenIdOf(screenId));
          screen?.lease.touchUser();
          send(response, 200, { holder: screen?.lease.holder ?? null });
          return;
        }
        default:
          send(response, 404, { error: "not found" });
      }
    } catch (error) {
      if (error instanceof BadRequest) {
        send(response, 400, { error: error.message });
        return;
      }
      deps.log(`[http] ${request.method} ${url.pathname} failed: ${String(error)}`);
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
    if (url.pathname === "/vnc") {
      void upgradeVnc(request, socket, head, url);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      switch (url.pathname) {
        case "/events":
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
        case "/codex":
          bridgeWebSocket(ws, deps.codexUrl, deps.log);
          return;
        case "/egress":
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
    if (control && screen.lease.holder?.kind !== "user") {
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
function bridgeWebSocket(client: WebSocket, target: string, log: (message: string) => void) {
  const upstream = new WebSocket(target, {
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });
  const pending: { data: WebSocket.RawData; isBinary: boolean }[] = [];
  upstream.on("open", () => {
    for (const message of pending) upstream.send(message.data, { binary: message.isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
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
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  });
  client.on("close", () => upstream.close());
}
