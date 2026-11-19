// The Responses API over a WebSocket, as Codex speaks it on the ChatGPT plan. Each `response.create`
// message is one model request, and when it extends the one before it on the same connection it
// sends only the new items with a `previous_response_id`. `ResponsesChain` rebuilds the full input
// the model saw, the way Codex itself decides what to leave out (`get_incremental_items` in
// codex-rs/core/src/client.rs): the last request's full input, then the items the last response
// added, then the items this message sent. `WebSocketResponseReader` reads each response's messages
// under the same capture budget as an HTTP body.

import {
  RESPONSE_TOO_LARGE,
  type RebuiltResponse,
  ResponseRebuilder,
  unreadable,
} from "./response";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The full input of one `response.create`, as `ResponsesChain` rebuilt it. */
export interface ChainedInput {
  /** The full input, or what was sent when it could not be rebuilt; null when `input` was not a list. */
  input: unknown[] | null;
  /**
   * How many items at the start of `input` the message did not send, because they came from the
   * previous request and response; null when `input` is exactly what was sent.
   */
  sentFrom: number | null;
  /** Why the input could not be rebuilt, when it couldn't. */
  warning: string | null;
}

/** What a chain may hold, in characters of JSON, before it lets go and stops rebuilding. */
const CHAIN_LIMIT = 64 * 1024 * 1024;

/**
 * One WebSocket connection's requests, in order. It keeps the last request's full input and the
 * items its response added, and only once that response completed, exactly as Codex does: a
 * failed response or a broken stream leaves Codex nothing to continue from, so its next request
 * sends everything again.
 */
export class ResponsesChain {
  /** The last request's full input, and roughly how many characters it holds. */
  private input: unknown[] | null = null;
  private inputSize = 0;
  /** The last response, once it completed: its id and the items it added, in arrival order. */
  private response: { id: string; output: unknown[]; size: number } | null = null;

  constructor(private readonly limit = CHAIN_LIMIT) {}

  /**
   * A `response.create` message: `body` as sent, and its size. Returns the full input and
   * remembers it as the base for the next message.
   */
  request(body: Record<string, unknown>, size: number): ChainedInput {
    const sent = Array.isArray(body.input) ? body.input : null;
    const previous =
      typeof body.previous_response_id === "string" && body.previous_response_id !== ""
        ? body.previous_response_id
        : null;
    const last = this.response;
    this.response = null;
    if (!previous) {
      this.keep(sent, size);
      return { input: sent, sentFrom: null, warning: null };
    }
    if (!sent || !this.input || !last || last.id !== previous) {
      this.forget();
      return {
        input: sent,
        sentFrom: null,
        warning: `the full input could not be rebuilt: ${previous} is not the response this connection last completed`,
      };
    }
    const sentFrom = this.input.length + last.output.length;
    const input = [...this.input, ...last.output, ...sent];
    this.keep(input, this.inputSize + last.size + size);
    return { input, sentFrom, warning: null };
  }

  /** The response to the last request completed (or ended incomplete) with these items. */
  completed(responseId: string | null, output: unknown[], size: number): void {
    // Codex continues only from a response with an id.
    this.response = responseId && this.input ? { id: responseId, output, size } : null;
  }

  /** The response failed or was cut short: the next request starts over. */
  failed(): void {
    this.response = null;
  }

  /** Something on the connection could not be read: nothing can be rebuilt until a full request. */
  forget(): void {
    this.input = null;
    this.inputSize = 0;
    this.response = null;
  }

  private keep(input: unknown[] | null, size: number) {
    if (!input || size > this.limit) return this.forget();
    this.input = input;
    this.inputSize = size;
  }
}

/** A JSON object of headers, as WebSocket events carry them, with only its string-like values. */
export function eventHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") headers[name.toLowerCase()] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean")
      headers[name.toLowerCase()] = String(entry);
  }
  return headers;
}

/**
 * A `codex.rate_limits` WebSocket event as the headers the same limits come in over HTTP
 * (`x-codex-primary-used-percent`, ...), so plan usage reads one way whatever the transport.
 * Mirrors `parse_rate_limit_event` in codex-rs/codex-api/src/rate_limits.rs.
 */
export function rateLimitEventHeaders(event: unknown): Record<string, string> {
  if (!isRecord(event) || event.type !== "codex.rate_limits") return {};
  const name =
    (typeof event.metered_limit_name === "string" && event.metered_limit_name.trim()) ||
    (typeof event.limit_name === "string" && event.limit_name.trim()) ||
    "codex";
  const prefix = `x-${name.toLowerCase().replaceAll("_", "-")}`;
  const headers: Record<string, string> = {};
  const set = (header: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) headers[header] = String(value);
    else if (typeof value === "string" && value !== "") headers[header] = value;
    else if (typeof value === "boolean") headers[header] = String(value);
  };
  const limits = isRecord(event.rate_limits) ? event.rate_limits : {};
  for (const window of ["primary", "secondary"] as const) {
    const values = limits[window];
    if (!isRecord(values)) continue;
    set(`${prefix}-${window}-used-percent`, values.used_percent);
    set(`${prefix}-${window}-window-minutes`, values.window_minutes);
    set(`${prefix}-${window}-reset-at`, values.reset_at);
  }
  if (isRecord(event.credits)) {
    set("x-codex-credits-has-credits", event.credits.has_credits);
    set("x-codex-credits-unlimited", event.credits.unlimited);
    set("x-codex-credits-balance", event.credits.balance);
  }
  set("x-codex-plan-type", event.plan_type);
  return headers;
}

/** What a header costs beyond its characters: its place in the object. */
const HEADER_COST = 8;

/** One WebSocket response, as `WebSocketResponseReader` read it. */
export interface WebSocketResponse {
  response: RebuiltResponse;
  /**
   * The items the response added, in the order they arrived, as Codex keeps them for the next
   * request; null when the reader gave up, so nothing can be rebuilt from it.
   */
  output: unknown[] | null;
  /** Characters of the messages those items came in. */
  outputSize: number;
  /** Headers its events carried, rate limits among them (`rateLimitEventHeaders`). */
  headers: Record<string, string>;
}

/**
 * Reads one response's WebSocket messages as they arrive, the way `ResponseReader` reads an HTTP
 * body: the events are rebuilt, and the headers they carry are kept. What it holds (the kept
 * events, the strings noted along the way, the headers) stays under `limit` characters, checked
 * after every message: past it, the reader lets go of everything and gives back only why. It still
 * reads each message after that, holding nothing, so the caller knows when the response ends.
 */
export class WebSocketResponseReader {
  private rebuilder = new ResponseRebuilder();
  private output: unknown[] = [];
  private outputSize = 0;
  private headers: Record<string, string> = {};
  private headersSize = 0;
  private abandonedFor: string | null = null;

  constructor(private readonly limit: number) {}

  /** Characters it holds now. */
  get held(): number {
    return this.rebuilder.held + this.headersSize;
  }

  get abandoned(): boolean {
    return this.abandonedFor !== null;
  }

  /** A binary message, which Codex never expects: noted, not read. */
  binary(): void {
    this.rebuilder.warn("a message was binary");
  }

  /** One text message. Returns its event, or null when it wasn't a JSON object. */
  message(text: string): Record<string, unknown> | null {
    if (this.abandonedFor === null) {
      try {
        return this.read(text);
      } catch (error) {
        // The connection goes on, and so does reading each message, so its end is still found.
        this.abandon(unreadable(error));
      }
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private read(text: string): Record<string, unknown> | null {
    const event = this.rebuilder.message(text);
    if (event) {
      for (const [name, value] of Object.entries({
        ...eventHeaders(event.headers),
        ...rateLimitEventHeaders(event),
      })) {
        const before = this.headers[name];
        this.headersSize += value.length - (before?.length ?? -name.length - HEADER_COST);
        this.headers[name] = value;
      }
      if (event.type === "response.output_item.done") {
        this.output.push(event.item);
        this.outputSize += text.length;
      }
    }
    if (this.held > this.limit) this.abandon(RESPONSE_TOO_LARGE);
    return event;
  }

  /** Stops reading and lets go of what it holds; the result gives only `reason`. */
  abandon(reason: string): void {
    if (this.abandonedFor !== null) return;
    this.abandonedFor = reason;
    this.rebuilder = new ResponseRebuilder();
    this.rebuilder.warn(reason);
    this.output = [];
    this.outputSize = 0;
    this.headers = {};
    this.headersSize = 0;
  }

  end(): WebSocketResponse {
    return {
      response: { ...this.rebuilder.finish(), stream: true },
      output: this.abandonedFor === null ? this.output : null,
      outputSize: this.outputSize,
      headers: this.headers,
    };
  }
}
