// Rebuilding a Responses API answer from what streamed by: the output items, text, reasoning
// summary, usage and how it ended. Events come from an SSE body (`SseDecoder`) or from
// WebSocket messages (`ResponseRebuilder.message()`); both feed `ResponseRebuilder.event()`. Ported from llm-logs' extract.rs.

import { redactedJson } from "./redact";

/** One server-sent event: its `event:` name and its `data:` lines joined. */
export interface SseEvent {
  event: string;
  data: string;
}

/** What a data line costs beyond its characters: its place in the list and the newline joining it. */
const DATA_LINE_COST = 8;

/**
 * Splits an SSE stream into events as chunks arrive. A chunk may end mid-line, and lines may end
 * in `\n`, `\r\n` or `\r`.
 */
export class SseDecoder {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private dataLength = 0;

  /**
   * What it holds between chunks, in characters: an unfinished line, and the event it belongs
   * to. Each data line also costs `DATA_LINE_COST`, so empty lines still count.
   */
  get pending(): number {
    return this.buffer.length + this.event.length + this.dataLength;
  }

  /** The events completed by this chunk. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const end = this.buffer.search(/\r\n|\r|\n/);
      if (end === -1) break;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (this.buffer[end] === "\r" && end === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + (this.buffer.startsWith("\r\n", end) ? 2 : 1));
      this.line(line, events);
    }
    return events;
  }

  /** The last event, when the stream ended without the blank line that closes it. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer) this.line(this.buffer, events);
    this.buffer = "";
    this.line("", events);
    return events;
  }

  private line(line: string, events: SseEvent[]) {
    if (line === "") {
      if (this.event || this.data.length)
        events.push({ event: this.event, data: this.data.join("\n") });
      this.event = "";
      this.data = [];
      this.dataLength = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") {
      this.data.push(value);
      this.dataLength += value.length + DATA_LINE_COST;
    }
  }
}

/** Token counts as the Responses API reports them. Input includes the cached tokens. */
export interface ResponseUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface RebuiltResponse {
  /** The body was an event stream. */
  stream: boolean;
  /** It reached `response.completed`, `.incomplete` or `.failed`, or was a whole JSON response. */
  complete: boolean;
  /** The body could be read at all. */
  parsed: boolean;
  responseId: string | null;
  model: string | null;
  /** The output items, in order, as the model sent them. */
  output: unknown[];
  text: string;
  reasoningSummary: string;
  usage: ResponseUsage | null;
  /** `completed`, `failed`, or `incomplete:<reason>`. */
  stopReason: string | null;
  error: { type: string; message: string } | null;
  /** What could not be read, such as an event that wasn't JSON. */
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The usage in a response object, or null when it has none. */
export function responseUsage(value: unknown): ResponseUsage | null {
  if (!isRecord(value)) return null;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  if (input === null && output === null) return null;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: count(inputDetails.cached_tokens) ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: count(outputDetails.reasoning_tokens) ?? 0,
  };
}

/** The assistant's text and its reasoning summary, from output items. */
export function outputTexts(output: unknown[]): { text: string; reasoningSummary: string } {
  const text: string[] = [];
  const summary: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const parts =
      item.type === "message" ? item.content : item.type === "reasoning" ? item.summary : null;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const piece = isRecord(part) ? str(part.text) : null;
      if (piece) (item.type === "message" ? text : summary).push(piece);
    }
  }
  return { text: text.join("\n\n"), reasoningSummary: summary.join("\n\n") };
}

/** What stands in for an error's message when it has none, and its envelope can't be kept. */
export const ERROR_TOO_DEEP =
  "the error had no message, and its envelope was nested too deeply to keep";

/**
 * An error's type and message. With no message of its own, the whole envelope stands in, without
 * the credentials its headers carry (`redactedJson`); `tooDeep` says it couldn't be kept.
 */
function errorOf(value: Record<string, unknown>): {
  error: { type: string; message: string };
  tooDeep: boolean;
} {
  const error = isRecord(value.error) ? value.error : value;
  const type = str(error.type) ?? str(error.code) ?? "error";
  const message = str(error.message);
  const envelope = message === null ? redactedJson(value) : null;
  return {
    error: {
      type: type === "error" ? (str(error.code) ?? type) : type,
      message: message ?? envelope?.text ?? ERROR_TOO_DEEP,
    },
    tooDeep: message === null && envelope === null,
  };
}

/** How many events that weren't JSON get a warning of their own, and how much of their name. */
const WARNED_BAD_EVENTS = 10;
const WARNED_NAME_LENGTH = 100;

/** The events whose data the rebuilder keeps until the end. */
const KEPT_EVENTS = new Set([
  "response.output_item.done",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/** Builds the response up from events, in the order they arrive. */
export class ResponseRebuilder {
  private readonly result: RebuiltResponse = {
    stream: false,
    complete: false,
    parsed: false,
    responseId: null,
    model: null,
    output: [],
    text: "",
    reasoningSummary: "",
    usage: null,
    stopReason: null,
    error: null,
    warnings: [],
  };
  /** Items finished so far, by `output_index` when the server gives one, else in arrival order. */
  private readonly items: { index: number; item: unknown }[] = [];
  /** Characters of the events whose data it keeps: the items and the final response. */
  private kept = 0;
  private badEvents = 0;

  /**
   * What it keeps until the end, in characters of the text it came from: the items, the final
   * response, and the strings and warnings it noted along the way.
   */
  get held(): number {
    const { responseId, model, stopReason, error, warnings } = this.result;
    let held = this.kept + (responseId?.length ?? 0) + (model?.length ?? 0);
    held += (stopReason?.length ?? 0) + (error ? error.type.length + error.message.length : 0);
    for (const warning of warnings) held += warning.length;
    return held;
  }

  /** One SSE event. Events whose data isn't JSON are noted and skipped. */
  sse(event: SseEvent): void {
    this.result.stream = true;
    this.result.parsed = true;
    if (event.data === "" || event.data === "[DONE]") return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      // The event's name comes from the stream: noted shortened, and only for the first few.
      this.badEvents += 1;
      const name = event.event ? ` (${event.event.slice(0, WARNED_NAME_LENGTH)})` : "";
      if (this.badEvents <= WARNED_BAD_EVENTS) this.warn(`an event${name} was not JSON`);
      else this.warn("more events were not JSON");
      return;
    }
    if (!isRecord(data)) return;
    const type = str(data.type) ?? event.event;
    if (KEPT_EVENTS.has(type)) this.kept += event.data.length;
    this.event(type, data);
  }

  /**
   * One WebSocket text message, which holds one event. Returns the event, so the caller can read
   * what else it carries (headers, rate limits), or null when it wasn't a JSON object.
   */
  message(text: string): Record<string, unknown> | null {
    this.result.stream = true;
    this.result.parsed = true;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.warn("a message was not JSON");
      return null;
    }
    if (!isRecord(data)) return null;
    const type = str(data.type) ?? "";
    if (KEPT_EVENTS.has(type)) this.kept += text.length;
    this.event(type, data);
    return data;
  }

  /** One event, by its type: from an SSE stream, or a WebSocket message. */
  event(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case "response.created":
      case "response.in_progress":
        if (isRecord(data.response)) this.fromResponse(data.response, false);
        break;
      case "response.output_item.done": {
        const index = count(data.output_index) ?? this.items.length;
        if (data.item !== undefined) this.items.push({ index, item: data.item });
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        this.result.complete = true;
        if (isRecord(data.response)) this.fromResponse(data.response, true);
        break;
      case "error":
        this.error(data);
        break;
    }
  }

  /** A body that isn't an event stream: a whole JSON response, or an error. */
  json(body: string): void {
    if (body.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      this.warn("the response was neither an event stream nor JSON");
      return;
    }
    // Only a Responses API response or an error envelope is rebuilt. Anything else (search
    // results, images, summaries) stays unread, so the caller keeps it as it came.
    if (isRecord(value) && value.object === "response") {
      this.result.parsed = true;
      this.result.complete = true;
      this.fromResponse(value, true);
    } else if (isRecord(value) && value.error !== undefined && value.error !== null) {
      this.result.parsed = true;
      this.result.complete = true;
      this.error(value);
    } else this.warn("the response was JSON, but not a Responses API response");
  }

  private error(envelope: Record<string, unknown>) {
    const { error, tooDeep } = errorOf(envelope);
    this.result.error = error;
    if (tooDeep) this.warn(ERROR_TOO_DEEP);
  }

  warn(warning: string): void {
    if (!this.result.warnings.includes(warning)) this.result.warnings.push(warning);
  }

  /** What was rebuilt so far; a stream cut short gives the items finished before it ended. */
  finish(): RebuiltResponse {
    if (this.items.length) {
      this.result.output = this.items
        .map((entry, arrival) => ({ ...entry, arrival }))
        .sort((a, b) => a.index - b.index || a.arrival - b.arrival)
        .map((entry) => entry.item);
    }
    if (this.result.stream && !this.result.complete)
      this.warn("the stream ended before the response did");
    Object.assign(this.result, outputTexts(this.result.output));
    return this.result;
  }

  private fromResponse(response: Record<string, unknown>, final: boolean) {
    this.result.responseId ??= str(response.id);
    this.result.model ??= str(response.model);
    if (!final) return;
    const status = str(response.status);
    if (status) this.result.stopReason = status;
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : null;
    const reason = details ? str(details.reason) : null;
    if (reason) this.result.stopReason = `incomplete:${reason}`;
    this.result.usage = responseUsage(response.usage) ?? this.result.usage;
    // A server that doesn't stream each item still lists them in the final response.
    if (!this.items.length && Array.isArray(response.output)) {
      response.output.forEach((item, index) => this.items.push({ index, item }));
    }
    if (isRecord(response.error)) this.error(response);
  }
}

/** Rebuilds a whole response body at once: an event stream or JSON, by its content type. */
export function rebuildResponse(body: string, contentType: string | null): RebuiltResponse {
  const reader = new ResponseReader(contentType);
  reader.push(new TextEncoder().encode(body));
  return reader.end();
}

/** What a reader gives up with when what it holds passes its limit. */
export const RESPONSE_TOO_LARGE = "the response was too large to read";

/** What a reader gives up with when reading failed: the response is still forwarded whole. */
export function unreadable(error: unknown): string {
  return `the response could not be read: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Reads a response body as its bytes arrive, without keeping the stream: an event stream is
 * rebuilt event by event, anything else is kept and read as JSON at the end. What it holds (an
 * unfinished event, the items so far, the JSON) stays under `limit` characters: past it, the
 * reader lets go of everything and gives back only why.
 */
export class ResponseReader {
  private rebuilder = new ResponseRebuilder();
  private sse = new SseDecoder();
  private readonly text = new TextDecoder();
  private mode: "sse" | "json" | null;
  private json = "";
  private abandonedFor: string | null = null;

  constructor(
    contentType: string | null,
    private readonly limit = 8 * 1024 * 1024,
  ) {
    this.mode = contentType?.includes("text/event-stream") ? "sse" : null;
  }

  /** Characters it holds now. */
  get held(): number {
    if (this.abandonedFor !== null) return 0;
    return this.mode === "sse" ? this.sse.pending + this.rebuilder.held : this.json.length;
  }

  /** Whether it gave up on this response. */
  get abandoned(): boolean {
    return this.abandonedFor !== null;
  }

  push(chunk: Uint8Array): void {
    if (this.abandonedFor !== null) return;
    try {
      this.read(this.text.decode(chunk, { stream: true }));
    } catch (error) {
      return this.abandon(unreadable(error));
    }
    if (this.held > this.limit) this.abandon(RESPONSE_TOO_LARGE);
  }

  /** Stops reading and lets go of what it holds; the result gives only `reason`. */
  abandon(reason: string): void {
    if (this.abandonedFor !== null) return;
    this.abandonedFor = reason;
    this.rebuilder = new ResponseRebuilder();
    this.sse = new SseDecoder();
    this.json = "";
  }

  end(): RebuiltResponse {
    if (this.abandonedFor === null) {
      try {
        this.read(this.text.decode());
        if (this.mode === "sse") for (const event of this.sse.end()) this.rebuilder.sse(event);
        else this.rebuilder.json(this.json);
        return this.rebuilder.finish();
      } catch (error) {
        this.abandon(unreadable(error));
      }
    }
    this.rebuilder.warn(this.abandonedFor!);
    return { ...this.rebuilder.finish(), stream: this.mode === "sse" };
  }

  private read(text: string) {
    if (!text) return;
    if (this.mode === null) {
      const start = (this.json + text).trimStart();
      // Too little to tell yet: nothing but space, or the start of a field name.
      if (
        !start ||
        ["event:", "data:"].some((field) => start.length < field.length && field.startsWith(start))
      ) {
        this.json += text;
        return;
      }
      this.mode = /^(event:|data:|:)/.test(start) ? "sse" : "json";
      text = this.json + text;
      this.json = "";
    }
    if (this.mode === "sse") {
      for (const event of this.sse.push(text)) this.rebuilder.sse(event);
      return;
    }
    this.json += text;
  }
}
