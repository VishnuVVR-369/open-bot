// The model proxy: Codex on the computer sends its model requests here, at
// `/model-proxy/<token>/<route>/...`, and the worker forwards them to the route's fixed upstream.
// Bytes pass through unchanged as they arrive, in both directions; a copy is read on the side and
// handed to the writer when the exchange ends. Forwarding never waits on logging or the database.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { type ModelRoute, headerValue, turnMetadata } from "@open-bot/domain";
import { errorMessage, type Logger } from "../../logger";
import { type Exchange, type ModelRequestRecord, recordExchange } from "./capture";
import { CAPTURE_LIMIT, ResponseTap } from "./response-tap";
import { MODEL_PROXY_PATH, modelProxyToken } from "./routing";

/** Request bodies past this are forwarded but not logged. Codex's largest are a few MB. */
const REQUEST_BODY_LIMIT = 32 * 1024 * 1024;
/** How long shutdown waits for requests still being forwarded or logged. */
const DRAIN_MS = 10_000;

/** Headers that belong to one connection, never forwarded (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The live runs the proxy asks before spending the API key. */
export interface ProxyRuns {
  /** The live run on the API key that one of these Codex threads belongs to, if any. */
  apiKeyRun(threadIds: readonly string[]): { apiKey: string; teammateId: string } | null;
}

/** What a route lets through: headers to set upstream, and whose request it is. */
type Access = { set: Record<string, string>; teammateId: string | null } | { refused: string };

/** A route: one fixed upstream, and how a request on it gets its credential. */
interface ProxyRoute {
  upstream(): string;
  authorize(headers: IncomingHttpHeaders): Access;
}

export interface ModelProxyDeps {
  env: { ENCRYPTION_KEY: string; OPENAI_API_BASE_URL: string };
  runs: ProxyRuns;
  writer: { add(record: ModelRequestRecord): void; lost(startedAt: Date[], reason: string): void };
  log: Pick<Logger, "warn" | "error">;
  /** Overrides `CAPTURE_LIMIT`, for tests. */
  captureLimit?: number;
}

/** The Codex threads a request names: its own, and the parent of a sub-agent's. */
function threadIdsOf(headers: IncomingHttpHeaders): string[] {
  const ids = [
    headerValue(headers, "thread-id"),
    headerValue(headers, "x-codex-parent-thread-id"),
    turnMetadata(headers, null).threadId,
  ];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Forwardable headers from Node's raw list: hop-by-hop ones and those `drop` names left out. */
function forwardable(raw: string[], drop: ReadonlySet<string> = new Set()): string[] {
  const listed = new Set<string>();
  for (let at = 0; at < raw.length; at += 2)
    if (raw[at]!.toLowerCase() === "connection")
      for (const name of raw[at + 1]!.split(",")) listed.add(name.trim().toLowerCase());
  const out: string[] = [];
  for (let at = 0; at < raw.length; at += 2) {
    const name = raw[at]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name) || drop.has(name)) continue;
    out.push(raw[at]!, raw[at + 1]!);
  }
  return out;
}

function sameToken(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, type: string, message: string) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type, message } }));
}

/** What the proxy reports; tests wait on these instead of on time. */
export type ModelProxyEvents = {
  /** An exchange is done with: its log was queued, counted as lost, or dropped after shutdown. */
  settled: [];
};

export class ModelProxy extends EventEmitter<ModelProxyEvents> {
  private readonly token: string;
  private readonly routes: Record<ModelRoute, ProxyRoute | null>;
  /** Exchanges from the request's arrival until their log is queued. */
  private readonly active = new Set<Exchange>();
  private readonly idle: (() => void)[] = [];

  constructor(private readonly deps: ModelProxyDeps) {
    super();
    this.token = modelProxyToken(deps.env.ENCRYPTION_KEY);
    this.routes = {
      api: {
        upstream: () => deps.env.OPENAI_API_BASE_URL,
        // The key goes only to a thread with a live run on the API key, which passed the cap check.
        authorize: (headers) => {
          const run = deps.runs.apiKeyRun(threadIdsOf(headers));
          if (!run) return { refused: "No run on the API key is using this thread." };
          return { set: { authorization: `Bearer ${run.apiKey}` }, teammateId: run.teammateId };
        },
      },
      // The ChatGPT plan's route, with WebSockets, comes next.
      plan: null,
    };
  }

  /**
   * Waits, up to `timeoutMs`, for requests still being forwarded or logged, so their logs reach
   * the writer before it stops. Those still running after it are recorded as lost.
   */
  async drain(timeoutMs = DRAIN_MS): Promise<void> {
    if (this.active.size) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.idle.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
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

  /** Whether a request is for the proxy. */
  handles(pathname: string): boolean {
    return pathname.startsWith(MODEL_PROXY_PATH);
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const raw = request.url ?? "/";
    const [token = "", route = "", ...rest] = raw.slice(MODEL_PROXY_PATH.length).split("/");
    const spec = Object.hasOwn(this.routes, route) ? this.routes[route as ModelRoute] : null;
    if (!sameToken(token, this.token) || !spec) {
      request.resume();
      sendJson(response, 404, "not_found", "Not found");
      return;
    }
    const endpoint = rest.length ? `/${rest.join("/")}` : "";
    this.forward(request, response, route as ModelRoute, spec, endpoint);
  }

  private forward(
    request: IncomingMessage,
    response: ServerResponse,
    route: ModelRoute,
    spec: ProxyRoute,
    endpoint: string,
  ) {
    const method = request.method ?? "GET";
    // Model requests are POSTs and are logged in full; anything else (the `models` list) only as metadata.
    const logBodies = method === "POST";
    const exchange: Exchange = {
      route,
      transport: "http",
      method,
      endpoint: endpoint.split("?")[0] || "/",
      teammateId: null,
      requestHeaders: request.headers,
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
    this.active.add(exchange);
    let finished = false;
    let tap: ResponseTap | null = null;
    // Called once, however the exchange ends; the log is put together off the request path.
    const finish = () => {
      if (finished) return;
      finished = true;
      exchange.endedAt = new Date();
      void (async () => {
        if (tap) {
          const read = await tap.end();
          exchange.response = read.response;
          exchange.rawResponse = read.raw;
          exchange.warnings.push(...read.warnings);
        }
        const record = await recordExchange(exchange, randomUUID());
        // Shutdown stopped waiting for it, and already counted it as lost.
        if (this.active.has(exchange)) this.deps.writer.add(record);
      })()
        .catch((error: unknown) => {
          this.deps.log.error("a model request could not be logged", {
            error: errorMessage(error),
          });
          if (this.active.has(exchange))
            this.deps.writer.lost([exchange.startedAt], "it could not be logged");
        })
        .finally(() => this.settle(exchange));
    };

    const access = spec.authorize(request.headers);
    if ("refused" in access) {
      request.resume();
      exchange.status = 403;
      exchange.failure = { type: "refused", message: access.refused };
      sendJson(response, 403, "refused", access.refused);
      finish();
      return;
    }
    exchange.teammateId = access.teammateId;

    const target = new URL(spec.upstream().replace(/\/+$/, "") + endpoint);
    const headers = forwardable(request.rawHeaders, new Set([...Object.keys(access.set), "host"]));
    // Given as a raw list, headers get no Host from Node: it is the upstream's.
    headers.push("host", target.host);
    for (const [name, value] of Object.entries(access.set)) headers.push(name, value);
    const upstream = (target.protocol === "https:" ? https : http).request(target, {
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
      if (logBodies) tap = new ResponseTap(answer.headers, this.deps.captureLimit ?? CAPTURE_LIMIT);
      answer.on("data", (chunk: Buffer) => {
        exchange.firstByteAt ??= new Date();
        exchange.responseBytes += chunk.length;
        tap?.write(chunk);
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
        message: `The model proxy could not reach ${target.host}: ${error.message}`,
      };
      if (!response.headersSent) {
        exchange.status = 502;
        sendJson(response, 502, "upstream_unreachable", exchange.failure.message);
      } else response.destroy();
      finish();
    });
  }
}
