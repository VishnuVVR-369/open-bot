// The model proxy: Codex on the computer sends its model requests here, at
// `/model-proxy/<token>/<route>/...`, and the worker forwards them to the route's fixed upstream,
// over HTTP or a WebSocket. Bytes pass through unchanged as they arrive, in both directions; a
// copy is read on the side and handed to the writer when the exchange ends. Forwarding never
// waits on logging or the database.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { type ModelRoute, isAccountHeader, isSecretHeader, unreadable } from "@open-bot/domain";
import { errorMessage, type Logger } from "../../logger";
import { type Exchange, type ModelRequestRecord, recordExchange } from "./capture";
import { REQUEST_BODY_LIMIT, forwardable, sameToken, sendJson, threadIdsOf } from "./forwarding";
import { MODEL_PROXY_PATH, modelProxyToken } from "./routing";
import { CAPTURE_LIMIT, ResponseTap } from "./response-tap";
import { checkUpgrade, rejectUpgrade } from "./upgrade";
import { WebSocketProxy } from "./websocket";

/** How long shutdown waits for requests still being forwarded or logged. */
const DRAIN_MS = 10_000;
/** ChatGPT's Codex backend: the plan route's upstream. */
export const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex";
/** The path Codex puts before every plan endpoint, so its base URL ends like ChatGPT's. */
export const PLAN_PREFIX = "/backend-api/codex";
/** The token a rehearsal's stand-in gets instead of anything Codex sent. */
export const REHEARSAL_TOKEN = "plan-rehearsal";

/** The live runs the proxy asks about a request's threads. */
export interface ProxyRuns {
  /** The live run on the API key that one of these Codex threads belongs to, if any. */
  apiKeyRun(threadIds: readonly string[]): { apiKey: string; teammateId: string } | null;
  /** The teammate whose live run one of these Codex threads belongs to, on either access mode. */
  teammateFor(threadIds: readonly string[]): string | null;
}

/** What a route lets through: headers to set and drop upstream, and whose request it is. */
export type Access =
  | { set: Record<string, string>; drop?: (name: string) => boolean; teammateId: string | null }
  | { refused: string };

/** A route: one fixed upstream, and how a request on it gets its credential. */
interface ProxyRoute {
  upstream: string;
  /** What every path on the route starts with and the upstream's URL already ends with. */
  prefix: string;
  authorize(headers: IncomingHttpHeaders): Access;
}

/** A request on a known route with the right token. */
interface Target {
  route: ModelRoute;
  spec: ProxyRoute;
  /** The path under the route's upstream, with its query. */
  endpoint: string;
}

export interface ModelProxyDeps {
  env: { ENCRYPTION_KEY: string; OPENAI_API_BASE_URL: string; OPEN_BOT_PLAN_BASE_URL?: string };
  runs: ProxyRuns;
  writer: { add(record: ModelRequestRecord): void; lost(startedAt: Date[], reason: string): void };
  log: Pick<Logger, "warn" | "error">;
  /** Overrides `CAPTURE_LIMIT`, for tests. */
  captureLimit?: number;
  /** Stands in for ChatGPT on the plan route, for tests; unlike a rehearsal, credentials pass. */
  chatgptUrl?: string;
}

/** A new exchange's record, before anything about its answer is known. */
export function newExchange(
  fields: Pick<Exchange, "route" | "transport" | "method" | "endpoint" | "requestHeaders">,
): Exchange {
  return {
    ...fields,
    teammateId: null,
    requestBody: null,
    requestBytes: 0,
    status: null,
    responseHeaders: null,
    response: null,
    rawResponse: null,
    responseBytes: 0,
    startedAt: new Date(),
    firstByteAt: null,
    endedAt: new Date(),
    failure: null,
    warnings: [],
  };
}

/** What the proxy reports; tests wait on these instead of on time. */
export type ModelProxyEvents = {
  /** An exchange is done with: its log was queued, counted as lost, or dropped after shutdown. */
  settled: [];
};

export class ModelProxy extends EventEmitter<ModelProxyEvents> {
  private readonly token: string;
  private readonly routes: Record<ModelRoute, ProxyRoute>;
  /** Exchanges from the request's arrival until their log is queued. */
  private readonly active = new Set<Exchange>();
  private readonly idle: (() => void)[] = [];
  private readonly sockets: WebSocketProxy;
  private draining = false;

  constructor(private readonly deps: ModelProxyDeps) {
    super();
    this.token = modelProxyToken(deps.env.ENCRYPTION_KEY);
    const rehearsal = Boolean(deps.env.OPEN_BOT_PLAN_BASE_URL);
    this.routes = {
      api: {
        upstream: deps.env.OPENAI_API_BASE_URL,
        prefix: "",
        // The key goes only to a thread with a live run on the API key, which passed the cap check.
        authorize: (headers) => {
          const run = deps.runs.apiKeyRun(threadIdsOf(headers));
          if (!run) return { refused: "No run on the API key is using this thread." };
          return { set: { authorization: `Bearer ${run.apiKey}` }, teammateId: run.teammateId };
        },
      },
      plan: {
        upstream: deps.env.OPEN_BOT_PLAN_BASE_URL ?? deps.chatgptUrl ?? CHATGPT_CODEX_URL,
        prefix: PLAN_PREFIX,
        // Codex sends its own ChatGPT login, which passes through to ChatGPT unchanged. A
        // rehearsal's stand-in gets none of it: every credential and the account are replaced.
        authorize: (headers): Access => {
          const teammateId = deps.runs.teammateFor(threadIdsOf(headers));
          if (!rehearsal) return { set: {}, teammateId };
          return {
            set: { authorization: `Bearer ${REHEARSAL_TOKEN}` },
            drop: (name) => isSecretHeader(name) || isAccountHeader(name),
            teammateId,
          };
        },
      },
    };
    this.sockets = new WebSocketProxy({
      track: (exchange) => this.active.add(exchange),
      complete: (exchange) => this.complete(exchange),
      teammateFor: (threadIds) => deps.runs.teammateFor(threadIds),
      draining: () => this.draining,
      captureLimit: deps.captureLimit ?? CAPTURE_LIMIT,
      log: deps.log,
    });
  }

  /**
   * Waits, up to `timeoutMs`, for requests still being forwarded or logged, so their logs reach
   * the writer before it stops, and for WebSockets to close: each closes as soon as no response
   * is streaming on it, once what is queued for Codex has been delivered. Whatever is still
   * running after it is dropped, and its requests recorded as lost.
   */
  async drain(timeoutMs = DRAIN_MS): Promise<void> {
    this.draining = true;
    this.sockets.closeIdle();
    const logged = this.active.size
      ? new Promise<void>((resolve) => this.idle.push(resolve))
      : Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([logged, this.sockets.closed()]),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]);
    clearTimeout(timer);
    this.sockets.terminate();
    if (!this.active.size) return;
    const starts = [...this.active].map((exchange) => exchange.startedAt);
    this.active.clear();
    this.deps.writer.lost(starts, "the worker shut down before they finished");
  }

  private settle(exchange: Exchange) {
    this.active.delete(exchange);
    if (!this.active.size) for (const resolve of this.idle.splice(0)) resolve();
    this.emit("settled");
  }

  /**
   * Logs a finished exchange off the request path, once `read` has finished reading its
   * response, then stops counting it as active. A response that can't be read is logged without
   * it, and a record that can't be put together without its bodies (`recordExchange`), each with
   * a warning; only one the writer can't take is counted as lost.
   */
  private complete(exchange: Exchange, read?: () => Promise<void>) {
    void (async () => {
      try {
        await read?.();
      } catch (error) {
        this.deps.log.error("a model proxy response could not be read", {
          error: errorMessage(error),
        });
        exchange.warnings.push(unreadable(error));
      }
      const record = await recordExchange(exchange, randomUUID());
      // Shutdown stopped waiting for it, and already counted it as lost.
      if (this.active.has(exchange)) this.deps.writer.add(record);
    })()
      .catch((error: unknown) => {
        this.deps.log.error("a model request could not be logged", { error: errorMessage(error) });
        if (this.active.has(exchange))
          this.deps.writer.lost([exchange.startedAt], "it could not be logged");
      })
      .finally(() => this.settle(exchange));
  }

  /** Whether a request is for the proxy. */
  handles(pathname: string): boolean {
    return pathname.startsWith(MODEL_PROXY_PATH);
  }

  /** The route and endpoint a URL names, or null when its token or route is wrong. */
  private target(url: string | undefined): Target | null {
    const [token = "", route = "", ...rest] = (url ?? "/")
      .slice(MODEL_PROXY_PATH.length)
      .split("/");
    if (!sameToken(token, this.token) || !Object.hasOwn(this.routes, route)) return null;
    const spec = this.routes[route as ModelRoute];
    const path = rest.length ? `/${rest.join("/")}` : "";
    if (!path.startsWith(spec.prefix)) return null;
    const endpoint = path.slice(spec.prefix.length);
    if (endpoint && !/^[/?]/.test(endpoint)) return null;
    return { route: route as ModelRoute, spec, endpoint };
  }

  /** The upstream URL and headers for a request the route let through. */
  private upstreamRequest(
    target: Target,
    request: IncomingMessage,
    access: Extract<Access, { set: unknown }>,
    skip: ReadonlySet<string> = new Set(),
  ) {
    const url = new URL(target.spec.upstream.replace(/\/+$/, "") + target.endpoint);
    const replaced = new Set([...Object.keys(access.set), "host", ...skip]);
    const headers = forwardable(
      request.rawHeaders,
      (name) => replaced.has(name) || Boolean(access.drop?.(name)),
    );
    for (const [name, value] of Object.entries(access.set)) headers.push(name, value);
    return { url, headers };
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const target = this.target(request.url);
    if (!target) {
      request.resume();
      sendJson(response, 404, "not_found", "Not found");
      return;
    }
    this.forward(request, response, target);
  }

  /**
   * A WebSocket upgrade for the proxy: the Responses API over a WebSocket. Nothing it does can
   * throw out of the worker's upgrade handler: a failure answers this upgrade alone.
   */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      this.openUpgrade(request, socket, head);
    } catch (error) {
      this.deps.log.error("a model proxy WebSocket upgrade failed", { error: errorMessage(error) });
      if (!socket.destroyed)
        rejectUpgrade(socket, 500, "proxy_error", "The model proxy could not take the upgrade.");
    }
  }

  private openUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = this.target(request.url);
    if (!target) return rejectUpgrade(socket, 404, "not_found", "Not found");
    if (this.draining) return rejectUpgrade(socket, 503, "restarting", "The worker is restarting.");
    // Checked before anything is opened upstream, as `ws` would check it after.
    const handshake = checkUpgrade(request);
    if ("problem" in handshake) return rejectUpgrade(socket, 400, "bad_request", handshake.problem);
    const exchange = newExchange({
      route: target.route,
      transport: "websocket",
      method: "GET",
      endpoint: target.endpoint.split("?")[0] || "/",
      requestHeaders: request.headers,
    });
    const access = target.spec.authorize(request.headers);
    if ("refused" in access) {
      this.active.add(exchange);
      exchange.status = 403;
      exchange.failure = { type: "refused", message: access.refused };
      rejectUpgrade(socket, 403, "refused", access.refused);
      this.complete(exchange);
      return;
    }
    const upstream = this.upstreamRequest(target, request, access, WebSocketProxy.HANDSHAKE);
    upstream.url.protocol = upstream.url.protocol === "https:" ? "wss:" : "ws:";
    this.sockets.open({
      request,
      socket,
      head,
      route: target.route,
      endpoint: exchange.endpoint,
      url: upstream.url,
      headers: upstream.headers,
      protocols: handshake.protocols,
      handshake: exchange,
      teammateId: access.teammateId,
    });
  }

  private forward(request: IncomingMessage, response: ServerResponse, target: Target) {
    const method = request.method ?? "GET";
    // Model requests are POSTs and are logged in full; anything else (the `models` list) only as metadata.
    const logBodies = method === "POST";
    const exchange = newExchange({
      route: target.route,
      transport: "http",
      method,
      endpoint: target.endpoint.split("?")[0] || "/",
      requestHeaders: request.headers,
    });
    this.active.add(exchange);
    let finished = false;
    let tap: ResponseTap | null = null;
    // Called once, however the exchange ends; the log is put together off the request path.
    const finish = () => {
      if (finished) return;
      finished = true;
      exchange.endedAt = new Date();
      this.complete(exchange, async () => {
        if (!tap) return;
        const read = await tap.end();
        exchange.response = read.response;
        exchange.rawResponse = read.raw;
        exchange.warnings.push(...read.warnings);
      });
    };

    const access = target.spec.authorize(request.headers);
    if ("refused" in access) {
      request.resume();
      exchange.status = 403;
      exchange.failure = { type: "refused", message: access.refused };
      sendJson(response, 403, "refused", access.refused);
      finish();
      return;
    }
    exchange.teammateId = access.teammateId;

    const { url: upstreamUrl, headers } = this.upstreamRequest(target, request, access);
    // Given as a raw list, headers get no Host from Node: it is the upstream's.
    headers.push("host", upstreamUrl.host);
    const upstream = (upstreamUrl.protocol === "https:" ? https : http).request(upstreamUrl, {
      method,
      headers,
    });

    // The request: forwarded as it arrives, and kept for the log up to a limit.
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      exchange.requestBytes += chunk.length;
      if (!logBodies) return;
      if (exchange.requestBytes <= REQUEST_BODY_LIMIT) body.push(chunk);
      else if (body.length) {
        body.length = 0;
        exchange.warnings.push("the request body was too large to log");
      }
    });
    request.on("end", () => {
      if (body.length) exchange.requestBody = Buffer.concat(body);
    });
    request.pipe(upstream);

    // The client went away first: stop the upstream request too, as a direct connection would.
    response.on("close", () => {
      if (response.writableFinished) return;
      upstream.destroy();
      exchange.failure ??= {
        type: "client_closed",
        message: "Codex closed the request before it ended.",
      };
      finish();
    });

    upstream.on("response", (answer) => {
      exchange.status = answer.statusCode ?? 502;
      exchange.responseHeaders = answer.headers;
      response.writeHead(exchange.status, answer.statusMessage, forwardable(answer.rawHeaders));
      response.flushHeaders();
      // Piped first, so each chunk is on its way to Codex before the copy is read.
      answer.pipe(response);
      // Reading the copy never throws into the response's events: a failure costs only the log's
      // copy, and the request is still logged, with a warning.
      const unread = (error: unknown) => {
        tap = null;
        this.deps.log.error("a model proxy response could not be read", {
          error: errorMessage(error),
        });
        exchange.warnings.push(unreadable(error));
      };
      if (logBodies)
        try {
          tap = new ResponseTap(answer.headers, this.deps.captureLimit ?? CAPTURE_LIMIT);
        } catch (error) {
          unread(error);
        }
      answer.on("data", (chunk: Buffer) => {
        exchange.firstByteAt ??= new Date();
        exchange.responseBytes += chunk.length;
        try {
          tap?.write(chunk);
        } catch (error) {
          unread(error);
        }
      });
      answer.on("end", finish);
      // The upstream broke off mid-stream: break the client's stream too, so Codex sees the same.
      const broken = () => {
        exchange.failure ??= {
          type: "upstream_aborted",
          message: "The upstream ended the response early.",
        };
        response.destroy();
        finish();
      };
      answer.on("aborted", broken);
      answer.on("error", broken);
    });

    upstream.on("error", (error) => {
      if (finished) return;
      exchange.failure ??= {
        type: "upstream_unreachable",
        message: `The model proxy could not reach ${upstreamUrl.host}: ${error.message}`,
      };
      if (!response.headersSent) {
        exchange.status = 502;
        sendJson(response, 502, "upstream_unreachable", exchange.failure.message);
      } else response.destroy();
      finish();
    });
  }
}
