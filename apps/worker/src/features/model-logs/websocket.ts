// The model proxy's WebSockets: Codex speaks the Responses API over a WebSocket on the ChatGPT
// plan. The proxy opens the upstream connection with Codex's headers first, answers Codex's
// upgrade with the upstream's, then relays every message, ping, pong and close both ways as it
// came. Each `response.create` is logged as one request, with its full input rebuilt when Codex
// sent only the new items (`ResponsesChain`). Forwarding never waits on reading, and a message
// that can't be read costs only its log.
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  ResponsesChain,
  TURN_METADATA_HEADER,
  WebSocketResponseReader,
  type ModelRoute,
  rebuildResponse,
  unreadable,
} from "@open-bot/domain";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { errorMessage, type Logger } from "../../logger";
import { type Exchange, decodeBody } from "./capture";
import { REQUEST_BODY_LIMIT, forwardable, threadIdsOf } from "./forwarding";
import { RAW_RESPONSE_LIMIT } from "./response-tap";
import { rejectUpgrade, relayRefusal } from "./upgrade";

/** The largest message relayed: above the 64 MiB Codex's own client accepts. */
const MAX_PAYLOAD = 128 * 1024 * 1024;
/** Past this many bytes waiting to go out to one side, the other side is paused. */
const HIGH_WATER = 8 * 1024 * 1024;
/** ...and resumed once it is back under this. */
const LOW_WATER = 1024 * 1024;
/** How long the upstream may take to answer the upgrade. */
const HANDSHAKE_MS = 30_000;
/** How much of a refused upgrade's body is logged; Codex gets all of it. */
const REFUSAL_BODY_LIMIT = 1024 * 1024;

/** What the relay needs from the proxy. */
export interface RelayHost {
  /** Counts an exchange as active until `complete` has logged it. */
  track(exchange: Exchange): void;
  complete(exchange: Exchange): void;
  teammateFor(threadIds: readonly string[]): string | null;
  draining(): boolean;
  captureLimit: number;
  log: Pick<Logger, "warn" | "error">;
}

/** One upgrade the proxy lets through, ready to be connected upstream. */
export interface RelayRequest {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  route: ModelRoute;
  /** The path under the route, without its query. */
  endpoint: string;
  url: URL;
  /** Name and value pairs to send upstream, the handshake's own left out. */
  headers: string[];
  /** The subprotocols Codex offered, already checked (`checkUpgrade`). */
  protocols: string[];
  /** The upgrade as an exchange, logged only if it fails. */
  handshake: Exchange;
  teammateId: string | null;
}

/** A close code that can be sent in a close frame (RFC 6455, section 7.4). */
function sendable(code: number): boolean {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || code >= 3000;
}

/** Closes `target` the way its peer closed: same code and reason, or dropped when it was dropped. */
function closeLike(target: WebSocket, code: number, reason: Buffer) {
  if (target.readyState === WebSocket.CLOSED) return;
  if (target.readyState === WebSocket.CONNECTING) return target.terminate();
  // Paused for backpressure, it would never read the close that answers this one.
  if (target.isPaused) target.resume();
  if (code === 1005) target.close();
  else if (sendable(code) && code <= 4999) target.close(code, reason);
  else target.terminate();
}

/** Codex's own codes for errors it retries, which end a response whatever their status. */
const RETRIED_ERRORS = new Set([
  "websocket_connection_limit_reached",
  "previous_response_not_found",
]);

/**
 * Whether an `error` event ends the response, as Codex reads it (`map_wrapped_websocket_error_event`
 * in codex-rs/codex-api/src/endpoint/responses_websocket.rs): a status that isn't a success, or a
 * code Codex retries. Any other error leaves it waiting for more.
 */
function endsResponse(event: Record<string, unknown>): boolean {
  const status = event.status ?? event.status_code;
  const error = isRecord(event.error) ? event.error : {};
  if (typeof error.code === "string" && RETRIED_ERRORS.has(error.code)) return true;
  return typeof status === "number" && (status < 200 || status > 299);
}

/** Name and value pairs as the object `ws` takes, a repeated name as a list. */
function headerObject(pairs: string[]): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (let at = 0; at < pairs.length; at += 2) {
    const name = pairs[at]!.toLowerCase();
    const value = pairs[at + 1]!;
    const seen = headers[name];
    headers[name] = seen === undefined ? value : [...[seen].flat(), value];
  }
  return headers;
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The WebSockets the proxy relays, and the server that completes Codex's upgrades. */
export class WebSocketProxy {
  /** Headers each hop's handshake sets for itself, never forwarded. */
  static readonly HANDSHAKE = new Set([
    "host",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "sec-websocket-accept",
  ]);

  private readonly server: WebSocketServer;
  private readonly relays = new Set<SocketRelay>();
  /** Waiting for every connection to have closed. */
  private readonly idle: (() => void)[] = [];
  /** The upstream's answer for each upgrade being completed: headers and subprotocol. */
  private readonly answers = new WeakMap<
    IncomingMessage,
    { headers: string[]; protocol: string }
  >();

  constructor(private readonly host: RelayHost) {
    // Codex's side of the relay is uncompressed: it is the private network, and saves the CPU.
    this.server = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      autoPong: false,
      maxPayload: MAX_PAYLOAD,
      handleProtocols: (_offered, request) => this.answers.get(request)?.protocol || false,
    });
    this.server.on("headers", (lines, request) => {
      const answer = this.answers.get(request);
      if (!answer) return;
      for (let at = 0; at < answer.headers.length; at += 2)
        lines.push(`${answer.headers[at]}: ${answer.headers[at + 1]}`);
    });
  }

  open(request: RelayRequest): void {
    let relay: SocketRelay;
    try {
      relay = new SocketRelay(this.host, request, {
        accept: (headers, protocol, attach) => {
          this.answers.set(request.request, { headers, protocol });
          try {
            this.server.handleUpgrade(request.request, request.socket, request.head, attach);
          } finally {
            this.answers.delete(request.request);
          }
        },
        closed: () => {
          this.relays.delete(relay);
          if (!this.relays.size) for (const resolve of this.idle.splice(0)) resolve();
        },
      });
    } catch (error) {
      // Nothing was opened upstream: the handshake held something a connection can't be opened with.
      this.host.log.warn("a model proxy WebSocket could not be opened", {
        error: errorMessage(error),
      });
      rejectUpgrade(
        request.socket,
        400,
        "bad_request",
        "The WebSocket upgrade could not be relayed.",
      );
      return;
    }
    this.relays.add(relay);
  }

  /** At shutdown: closes every connection with no response streaming, the rest when it ends. */
  closeIdle(): void {
    for (const relay of this.relays) relay.goAwayWhenIdle();
  }

  /** Resolves once every connection has closed on both sides, its last bytes delivered. */
  closed(): Promise<void> {
    if (!this.relays.size) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  /** Drops every connection still open. */
  terminate(): void {
    for (const relay of this.relays) relay.terminate();
  }
}

/** A response Codex asked for, and what is read from it so far. */
interface Streaming {
  exchange: Exchange;
  reader: WebSocketResponseReader;
  /** The start of the messages as they came, in case the response can't be rebuilt. */
  raw: string[];
  rawLength: number;
  rawCut: boolean;
  /** Another request overlapped it, so which events are its own can't be told for certain. */
  ambiguous: boolean;
}

interface RelayHooks {
  accept(headers: string[], protocol: string, attach: (client: WebSocket) => void): void;
  closed(): void;
}

/** What a request that overlapped another is logged with. */
const OVERLAPPED =
  "another request was sent on this connection while a response was streaming, so events were read in order and may belong to the other request";

/** One Codex connection, and its upstream. */
class SocketRelay {
  private readonly upstream: WebSocket;
  private client: WebSocket | null = null;
  private readonly chain = new ResponsesChain();
  /** Responses asked for that haven't ended, oldest first: the model answers them in order. */
  private readonly pending: Streaming[] = [];
  /** The handshake's request headers, logged with every message; the turn comes from each message. */
  private readonly requestHeaders: IncomingHttpHeaders;
  private responseHeaders: IncomingHttpHeaders = {};
  /** Whether the upgrade was answered (accepted, refused or failed). */
  private answered = false;
  private socketClosed = false;
  private goingAway = false;
  private done = false;

  constructor(
    private readonly host: RelayHost,
    private readonly params: RelayRequest,
    private readonly hooks: RelayHooks,
  ) {
    const { request, socket } = params;
    // Each message names its own turn, so the handshake's turn is left out, with the headers that
    // belong to the handshake itself.
    this.requestHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) =>
          name !== TURN_METADATA_HEADER &&
          name !== "connection" &&
          name !== "upgrade" &&
          !name.startsWith("sec-websocket-"),
      ),
    );
    // Compressed upstream when Codex asked for it, as a direct connection would be.
    const deflate = /permessage-deflate/i.test(request.headers["sec-websocket-extensions"] ?? "");
    // The one call here that can throw; nothing is open until it returns.
    this.upstream = new WebSocket(params.url, params.protocols, {
      headers: headerObject(params.headers),
      perMessageDeflate: deflate,
      autoPong: false,
      maxPayload: MAX_PAYLOAD,
      followRedirects: false,
      handshakeTimeout: HANDSHAKE_MS,
    });
    this.upstream.once("upgrade", (response) => (this.responseHeaders = response.headers));
    this.upstream.once("open", () => this.accept());
    this.upstream.once("unexpected-response", (_request, response) => this.refused(response));
    this.upstream.on("error", (error) => this.upstreamError(error));
    this.upstream.on("close", (code, reason) => this.upstreamClosed(code, reason));
    socket.on("error", () => {});
    socket.once("close", () => {
      this.socketClosed = true;
      // Codex gave up before the upstream answered, or while a refusal was passed on.
      if (!this.client) this.upstream.terminate();
      this.settleIfClosed();
    });
  }

  /** The upstream accepted: answer Codex's upgrade with its headers, and start relaying. */
  private accept() {
    this.answered = true;
    if (!this.params.socket.destroyed) {
      try {
        const answer = this.upstreamAnswer();
        this.hooks.accept(answer, this.upstream.protocol, (client) => this.attach(client));
      } catch (error) {
        this.host.log.warn("a model proxy WebSocket upgrade could not be completed", {
          error: errorMessage(error),
        });
        if (!this.client) this.params.socket.destroy();
      }
    }
    // Codex left meanwhile, or its upgrade could not be completed: the upstream goes too.
    if (this.client) return;
    this.upstream.terminate();
    this.settleIfClosed();
  }

  /** The upstream's upgrade answer, as headers to give Codex. */
  private upstreamAnswer(): string[] {
    const raw: string[] = [];
    for (const [name, value] of Object.entries(this.responseHeaders))
      for (const one of [value ?? []].flat()) raw.push(name, String(one));
    return forwardable(raw, WebSocketProxy.HANDSHAKE);
  }

  private attach(client: WebSocket) {
    this.client = client;
    const upstream = this.upstream;
    client.on("message", (data, binary) => {
      const bytes = asBuffer(data);
      if (this.relay(upstream, client, bytes, binary) && !binary)
        this.read(() => this.fromCodex(bytes));
    });
    upstream.on("message", (data, binary) => {
      const bytes = asBuffer(data);
      if (this.relay(client, upstream, bytes, binary))
        this.read(() => this.fromModel(bytes, binary));
    });
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      from.on("ping", (data) => to.readyState === WebSocket.OPEN && to.ping(data));
      from.on("pong", (data) => to.readyState === WebSocket.OPEN && to.pong(data));
    }
    client.on("error", () => {});
    client.on("close", (code, reason) => {
      this.endAll({
        type: "client_closed",
        message: "Codex closed the connection before the response ended.",
      });
      closeLike(upstream, code, reason);
      this.settleIfClosed();
    });
    if (this.goingAway) this.goAwayWhenIdle();
  }

  /**
   * Sends a message on to `to`, pausing `from` while `to` can't keep up. Returns whether it was
   * sent: nothing goes to a side that is closing.
   */
  private relay(to: WebSocket, from: WebSocket, data: Buffer, binary: boolean): boolean {
    if (to.readyState !== WebSocket.OPEN) return false;
    to.send(data, { binary }, () => {
      if (from.isPaused && to.bufferedAmount < LOW_WATER) from.resume();
    });
    if (to.bufferedAmount > HIGH_WATER && !from.isPaused) from.pause();
    return true;
  }

  /** Reads a relayed message for the log. A failure there costs the log, never the connection. */
  private read(work: () => void) {
    try {
      work();
    } catch (error) {
      this.host.log.error("a model proxy WebSocket message could not be read", {
        error: errorMessage(error),
      });
      this.chain.forget();
      for (const streaming of this.pending)
        streaming.exchange.warnings.push(`a message could not be read: ${errorMessage(error)}`);
    }
  }

  /** A message from Codex, already forwarded: a new request when it is a `response.create`. */
  private fromCodex(data: Buffer) {
    let body: unknown = null;
    if (data.length <= REQUEST_BODY_LIMIT) {
      try {
        body = JSON.parse(data.toString("utf8"));
      } catch {
        body = null;
      }
    }
    const create = isRecord(body)
      ? body.type === "response.create"
      : data.subarray(0, 256).includes('"response.create"');
    if (!create) return;
    const exchange: Exchange = {
      route: this.params.route,
      transport: "websocket",
      method: "response.create",
      endpoint: this.params.endpoint,
      teammateId: null,
      requestHeaders: this.requestHeaders,
      requestBody: null,
      requestBytes: data.length,
      // Already relayed upstream: it may cost money from here on.
      sent: true,
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
    if (isRecord(body)) {
      exchange.requestJson = body;
      exchange.teammateId = this.params.teammateId;
      try {
        const chained = this.chain.request(body, data.length);
        if (chained.input !== body.input) exchange.requestJson = { ...body, input: chained.input };
        exchange.sentInputFrom = chained.sentFrom;
        if (chained.warning) exchange.warnings.push(chained.warning);
        exchange.teammateId = this.host.teammateFor(threadIdsOf(this.requestHeaders, body));
      } catch (error) {
        // Logged as sent: nothing can be rebuilt until the next full request.
        this.chain.forget();
        exchange.warnings.push(`the full input could not be rebuilt: ${errorMessage(error)}`);
      }
    } else {
      // Too large to read, or not JSON: nothing can be rebuilt until the next full request.
      this.chain.forget();
      exchange.teammateId = this.params.teammateId;
      exchange.warnings.push(
        data.length > REQUEST_BODY_LIMIT
          ? "the request body was too large to log"
          : "the request body was not JSON",
      );
    }
    const streaming: Streaming = {
      exchange,
      reader: new WebSocketResponseReader(this.host.captureLimit),
      raw: [],
      rawLength: 0,
      rawCut: false,
      ambiguous: false,
    };
    // Codex sends one request at a time on a connection. Should two overlap, the model's events
    // are read in order, oldest request first, but which response an event belongs to can't be
    // told for certain: each overlapping request says so, and none is continued from.
    if (this.pending.length) {
      for (const overlapped of [...this.pending, streaming]) {
        if (overlapped.ambiguous) continue;
        overlapped.ambiguous = true;
        overlapped.exchange.warnings.push(OVERLAPPED);
      }
      this.chain.forget();
    }
    this.host.track(exchange);
    this.pending.push(streaming);
  }

  /** A message from the model, already forwarded: read into the oldest response not ended. */
  private fromModel(data: Buffer, binary: boolean) {
    const current = this.pending[0];
    if (!current) return;
    const exchange = current.exchange;
    exchange.firstByteAt ??= new Date();
    exchange.responseBytes += data.length;
    exchange.status ??= 200;
    if (binary) return current.reader.binary();
    const text = data.toString("utf8");
    // The start of the response as it came, besides the budget, like an HTTP body's.
    if (current.rawLength < RAW_RESPONSE_LIMIT) {
      const kept = text.slice(0, RAW_RESPONSE_LIMIT - current.rawLength);
      current.rawCut ||= kept.length < text.length;
      current.raw.push(kept);
      current.rawLength += kept.length + 1;
    } else current.rawCut = true;
    const event = current.reader.message(text);
    if (!event) return;
    const type = event.type;
    if (type === "response.completed" || type === "response.incomplete") {
      // Codex continues from an incomplete response as from a completed one.
      const response = isRecord(event.response) ? event.response : {};
      this.end(null, typeof response.id === "string" ? response.id : null);
    } else if (type === "response.failed") this.end(null);
    else if (type === "error" && endsResponse(event)) {
      exchange.status = Number(event.status ?? event.status_code ?? exchange.status);
      this.end(null);
    }
  }

  /**
   * The oldest response not ended has now ended: logs it. `failure` says why when it was cut
   * short, and `completed` is the id of a response that completed (or ended incomplete), the one
   * Codex continues from.
   */
  private end(failure: Exchange["failure"], completed?: string | null) {
    const current = this.pending.shift();
    if (!current) return;
    const exchange = current.exchange;
    exchange.endedAt = new Date();
    exchange.failure ??= failure;
    exchange.responseHeaders = this.responseHeaders;
    try {
      const read = current.reader.end();
      if (current.ambiguous) this.chain.forget();
      else if (completed === undefined) this.chain.failed();
      else if (read.output) this.chain.completed(completed, read.output, read.outputSize);
      // Too large to read: what it added is unknown.
      else this.chain.forget();
      exchange.responseHeaders = { ...this.responseHeaders, ...read.headers };
      exchange.response = read.response;
      // Message by message, so each is redacted on its own (`redactRawResponse`).
      exchange.rawResponse = current.raw.length ? current.raw : null;
      if (current.rawCut && (!read.response.parsed || !read.response.complete))
        exchange.warnings.push(
          `only the first ${current.rawLength - 1} characters of the response were kept`,
        );
    } catch (error) {
      // The response ended all the same: it is logged, without what couldn't be read.
      this.host.log.error("a model proxy WebSocket response could not be read", {
        error: errorMessage(error),
      });
      this.chain.forget();
      exchange.warnings.push(unreadable(error));
    }
    this.host.complete(exchange);
    if (this.goingAway) this.goAwayWhenIdle();
  }

  /** Every response not ended is cut short, for the same reason. */
  private endAll(failure: NonNullable<Exchange["failure"]>) {
    while (this.pending.length) this.end(failure);
  }

  private upstreamClosed(code: number, reason: Buffer) {
    if (!this.client) return this.settleIfClosed();
    this.endAll({
      type: "upstream_aborted",
      message: `The upstream closed the connection (${code}) before the response ended.`,
    });
    closeLike(this.client, code, reason);
    this.settleIfClosed();
  }

  private upstreamError(error: Error) {
    // After the upgrade, the close that follows says what Codex sees.
    if (this.answered) return;
    this.answered = true;
    const handshake = this.params.handshake;
    const message = `The model proxy could not reach ${this.params.url.host}: ${error.message}`;
    handshake.status = 502;
    handshake.failure = { type: "upstream_unreachable", message };
    rejectUpgrade(this.params.socket, 502, "upstream_unreachable", message);
    this.logHandshake();
  }

  /**
   * The upstream answered the upgrade without upgrading: Codex gets the same answer, its status
   * at once and its body as it streams. Only the log's copy of the body is limited.
   */
  private refused(response: IncomingMessage) {
    this.answered = true;
    const handshake = this.params.handshake;
    handshake.status = response.statusCode ?? 502;
    handshake.responseHeaders = response.headers;
    handshake.firstByteAt = new Date();
    // Counted while the answer streams, so shutdown waits for it or records it as lost.
    this.host.track(handshake);
    const kept: Buffer[] = [];
    let keptBytes = 0;
    relayRefusal(response, this.params.socket, (chunk) => {
      handshake.responseBytes += chunk.length;
      if (keptBytes >= REFUSAL_BODY_LIMIT) return;
      const piece = chunk.subarray(0, REFUSAL_BODY_LIMIT - keptBytes);
      kept.push(piece);
      keptBytes += piece.length;
    })
      .catch(() => handshake.warnings.push("the answer was cut short"))
      .then(async () => {
        this.upstream.terminate();
        if (handshake.responseBytes > keptBytes)
          handshake.warnings.push(`only the first ${keptBytes} bytes of the answer were kept`);
        const body = Buffer.concat(kept);
        const decoded = await decodeBody(body, response.headers["content-encoding"]);
        const text = (decoded ?? body).toString("utf8");
        handshake.response = rebuildResponse(text, response.headers["content-type"] ?? null);
        handshake.rawResponse = text.slice(0, RAW_RESPONSE_LIMIT);
      })
      .catch((error: unknown) =>
        handshake.warnings.push(`the answer could not be read: ${errorMessage(error)}`),
      )
      .finally(() => this.logHandshake(true));
  }

  /** Logs an upgrade that did not open a connection. */
  private logHandshake(tracked = false) {
    const handshake = this.params.handshake;
    handshake.teammateId = this.params.teammateId;
    handshake.endedAt = new Date();
    if (!tracked) this.host.track(handshake);
    this.host.complete(handshake);
  }

  /** At shutdown: closes the connection now if no response is streaming, else once it ends. */
  goAwayWhenIdle() {
    this.goingAway = true;
    if (this.pending.length) return;
    if (!this.client) {
      if (!this.answered) {
        this.upstream.terminate();
        this.params.socket.destroy();
        this.finish();
      }
      return;
    }
    // A close goes out after whatever is still queued for each side.
    const reason = Buffer.from("The worker is restarting.");
    closeLike(this.client, 1001, reason);
    closeLike(this.upstream, 1001, reason);
  }

  /** Drops the connection on both sides, as a worker that stopped would. */
  terminate() {
    this.goingAway = false;
    this.endAll({
      type: "client_closed",
      message: "The worker shut down before the response ended.",
    });
    this.client?.terminate();
    this.upstream.terminate();
    if (!this.client) this.params.socket.destroy();
    this.finish();
  }

  /** Done once both sides have closed, so everything queued for them was delivered first. */
  private settleIfClosed() {
    const codexClosed = this.client
      ? this.client.readyState === WebSocket.CLOSED
      : this.socketClosed;
    if (codexClosed && this.upstream.readyState === WebSocket.CLOSED) this.finish();
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this.hooks.closed();
  }
}
