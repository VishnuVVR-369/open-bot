import { describe, expect, it } from "vitest";
import { isRateLimitHeader } from "./headers";
import { RESPONSE_TOO_LARGE, ResponseRebuilder } from "./response";
import {
  ResponsesChain,
  WebSocketResponseReader,
  eventHeaders,
  rateLimitEventHeaders,
} from "./websocket";

// Sequences from Codex 0.162.1's own WebSocket tests (codex-rs/core/tests/suite/client_websockets.rs),
// seen from the wire: what each `response.create` sent, and what each response added.

const message = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (id: string, text: string) => ({
  type: "message",
  role: "assistant",
  id,
  content: [{ type: "output_text", text }],
});
const call = (id: string) => ({
  type: "function_call",
  call_id: id,
  name: "exec_command",
  arguments: '{"cmd":"ls"}',
});
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "a.txt" });

/** A `response.create` as Codex sends it over a WebSocket. */
function create(input: unknown[], previous?: string, extra: Record<string, unknown> = {}) {
  return {
    type: "response.create",
    model: "gpt-6.1-sol",
    stream: true,
    ...(previous ? { previous_response_id: previous } : {}),
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    include: [],
    ...extra,
  };
}

function send(chain: ResponsesChain, body: Record<string, unknown>) {
  return chain.request(body, JSON.stringify(body).length);
}

describe("ResponsesChain", () => {
  it("rebuilds an incremental create on a prefix (responses_websocket_uses_incremental_create_on_prefix)", () => {
    const chain = new ResponsesChain();
    expect(send(chain, create([message("hello")]))).toEqual({
      input: [message("hello")],
      sentFrom: null,
      warning: null,
    });
    chain.completed("resp-1", [assistant("msg_1", "assistant output")], 100);
    expect(send(chain, create([message("second")], "resp-1"))).toEqual({
      input: [message("hello"), assistant("msg_1", "assistant output"), message("second")],
      sentFrom: 2,
      warning: null,
    });
  });

  it("rebuilds a turn's tool calls and keeps chaining across turns (responses_websocket_v2_incremental_requests_are_reused_across_turns)", () => {
    const chain = new ResponsesChain();
    send(chain, create([message("hello")]));
    // The model calls a tool; Codex sends back only the tool's output.
    chain.completed("resp-1", [call("call_1")], 100);
    expect(send(chain, create([output("call_1")], "resp-1")).input).toEqual([
      message("hello"),
      call("call_1"),
      output("call_1"),
    ]);
    chain.completed("resp-2", [assistant("msg_2", "a.txt is there")], 100);
    // The next turn, on the same connection, sends only the new message.
    const third = send(chain, create([message("third")], "resp-2"));
    expect(third).toEqual({
      input: [
        message("hello"),
        call("call_1"),
        output("call_1"),
        assistant("msg_2", "a.txt is there"),
        message("third"),
      ],
      sentFrom: 4,
      warning: null,
    });
  });

  it("rebuilds the request after a prewarm, which sent nothing new (responses_websocket_request_prewarm_reuses_connection)", () => {
    const chain = new ResponsesChain();
    send(chain, create([message("hello")], undefined, { generate: false }));
    chain.completed("warm-1", [], 0);
    expect(send(chain, create([], "warm-1"))).toEqual({
      input: [message("hello")],
      sentFrom: 1,
      warning: null,
    });
  });

  it("takes a create without a previous response as the whole input (responses_websocket_creates_on_non_prefix)", () => {
    const chain = new ResponsesChain();
    send(chain, create([message("hello")]));
    chain.completed("resp-1", [assistant("msg_1", "out")], 100);
    expect(send(chain, create([message("different")]))).toEqual({
      input: [message("different")],
      sentFrom: null,
      warning: null,
    });
    // And chains from it.
    chain.completed("resp-2", [], 0);
    expect(send(chain, create([message("more")], "resp-2")).input).toEqual([
      message("different"),
      message("more"),
    ]);
  });

  it("starts over after a failed response (responses_websocket_v2_after_error_uses_full_create_without_previous_response_id)", () => {
    const chain = new ResponsesChain();
    send(chain, create([message("hello")]));
    chain.completed("resp-1", [], 0);
    expect(send(chain, create([message("second")], "resp-1")).sentFrom).toBe(1);
    chain.failed();
    // Codex sends the next one in full, on a new connection or the same one.
    const third = send(chain, create([message("hello"), message("second"), message("third")]));
    expect(third).toEqual({
      input: [message("hello"), message("second"), message("third")],
      sentFrom: null,
      warning: null,
    });
  });

  it("stores a request it can't rebuild as sent, with a warning, and recovers on the next full one", () => {
    const chain = new ResponsesChain();
    // Unknown on this connection: nothing was sent before it.
    const orphan = send(chain, create([message("more")], "resp-elsewhere"));
    expect(orphan.input).toEqual([message("more")]);
    expect(orphan.sentFrom).toBeNull();
    expect(orphan.warning).toContain("resp-elsewhere");

    // Not the response that completed last.
    send(chain, create([message("hello")]));
    chain.completed("resp-1", [], 0);
    expect(send(chain, create([message("x")], "resp-0")).warning).toContain("resp-0");
    // Once one link is missing, the next continuation can't be rebuilt either.
    chain.completed("resp-2", [], 0);
    expect(send(chain, create([message("y")], "resp-2")).warning).toContain("resp-2");

    // A response that failed leaves nothing to continue from.
    send(chain, create([message("hello")]));
    chain.failed();
    expect(send(chain, create([message("z")], "resp-3")).warning).not.toBeNull();

    // A full request starts a new chain.
    send(chain, create([message("fresh")]));
    chain.completed("resp-4", [], 0);
    expect(send(chain, create([message("again")], "resp-4")).warning).toBeNull();
  });

  it("does not continue from a response without an id", () => {
    const chain = new ResponsesChain();
    send(chain, create([message("hello")]));
    chain.completed(null, [assistant("msg_1", "out")], 100);
    expect(send(chain, create([message("more")], "resp-1")).warning).not.toBeNull();
  });

  it("lets go of a chain past its limit, rather than hold it", () => {
    const chain = new ResponsesChain(400);
    const first = create([message("hello")]);
    send(chain, first);
    chain.completed("resp-1", [assistant("msg_1", "x".repeat(250))], 300);
    const second = send(chain, create([message("more")], "resp-1"));
    expect(second.sentFrom).toBe(2);
    // It returned the rebuilt input, but holds too much to rebuild the next.
    chain.completed("resp-2", [], 0);
    expect(send(chain, create([message("again")], "resp-2")).warning).not.toBeNull();
  });
});

describe("WebSocket events", () => {
  it("reads a codex.rate_limits event as the plan's rate-limit headers", () => {
    // From responses_websocket_emits_rate_limit_events.
    const headers = rateLimitEventHeaders({
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 42, window_minutes: 60, reset_at: 1700000000 },
        secondary: null,
      },
      code_review_rate_limits: null,
      credits: { has_credits: true, unlimited: false, balance: "123" },
      promo: null,
    });
    expect(headers).toEqual({
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "60",
      "x-codex-primary-reset-at": "1700000000",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-credits-balance": "123",
      "x-codex-plan-type": "plus",
    });
    expect(Object.keys(headers).every(isRateLimitHeader)).toBe(true);
  });

  it("names a metered limit's headers after it", () => {
    const headers = rateLimitEventHeaders({
      type: "codex.rate_limits",
      metered_limit_name: "codex_other",
      rate_limits: { primary: { used_percent: 7.5, window_minutes: 300 } },
    });
    expect(headers).toEqual({
      "x-codex-other-primary-used-percent": "7.5",
      "x-codex-other-primary-window-minutes": "300",
    });
    expect(Object.keys(headers).every(isRateLimitHeader)).toBe(true);
    expect(rateLimitEventHeaders({ type: "response.created" })).toEqual({});
  });

  it("reads an event's headers, keeping only plain values", () => {
    expect(
      eventHeaders({ "X-Models-Etag": "etag-123", "x-n": 3, nested: { no: true }, gone: null }),
    ).toEqual({ "x-models-etag": "etag-123", "x-n": "3" });
    expect(eventHeaders("nope")).toEqual({});
  });

  it("rebuilds a response from WebSocket messages, including a wrapped error", () => {
    const rebuilder = new ResponseRebuilder();
    for (const event of [
      { type: "codex.response.metadata", headers: { "x-models-etag": "etag-123" } },
      { type: "response.created", response: { id: "resp-1", model: "gpt-6.1-sol" } },
      { type: "response.output_item.done", output_index: 0, item: assistant("msg_1", "pong") },
      {
        type: "response.completed",
        response: {
          id: "resp-1",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    ])
      rebuilder.message(JSON.stringify(event));
    expect(rebuilder.finish()).toMatchObject({
      stream: true,
      complete: true,
      parsed: true,
      responseId: "resp-1",
      text: "pong",
      stopReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
      warnings: [],
    });

    // From responses_websocket_usage_limit_error_emits_rate_limit_event.
    const limited = new ResponseRebuilder();
    const event = limited.message(
      JSON.stringify({
        type: "error",
        status: 429,
        error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
        headers: { "x-codex-primary-used-percent": "100.0" },
      }),
    );
    expect(event?.status).toBe(429);
    expect(limited.message("not json")).toBeNull();
    expect(limited.finish()).toMatchObject({
      error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
      warnings: ["a message was not JSON", "the stream ended before the response did"],
    });
  });
});

describe("WebSocketResponseReader", () => {
  const LIMIT = 4_096;
  const done = (index: number, text: string) =>
    JSON.stringify({
      type: "response.output_item.done",
      output_index: index,
      item: assistant(`msg_${index}`, text),
    });
  const completed = JSON.stringify({
    type: "response.completed",
    response: { id: "resp-1", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
  });

  /** Feeds messages, checking what it holds stays within the limit and one message after each. */
  function feed(reader: WebSocketResponseReader, messages: string[]) {
    for (const text of messages) {
      reader.message(text);
      expect(reader.held).toBeLessThanOrEqual(LIMIT + text.length);
    }
  }

  it("keeps a response within its budget, and the items Codex continues from", () => {
    const reader = new WebSocketResponseReader(LIMIT);
    feed(reader, [
      JSON.stringify({ type: "codex.response.metadata", headers: { "x-models-etag": "e1" } }),
      JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 5 } } }),
      done(0, "pong"),
      completed,
    ]);
    const read = reader.end();
    expect(read.output).toEqual([assistant("msg_0", "pong")]);
    expect(read.headers).toEqual({
      "x-models-etag": "e1",
      "x-codex-primary-used-percent": "5",
    });
    expect(read.response).toMatchObject({ text: "pong", complete: true, warnings: [] });
  });

  it("counts kept events toward the budget, and lets go of everything past it", () => {
    const reader = new WebSocketResponseReader(LIMIT);
    feed(
      reader,
      Array.from({ length: 50 }, (_, index) => done(index, "x".repeat(200))),
    );
    expect(reader.abandoned).toBe(true);
    // Abandoned, it holds only why, however much more comes.
    feed(reader, [...Array.from({ length: 50 }, () => done(0, "y".repeat(200))), completed]);
    expect(reader.held).toBeLessThan(100);
    const read = reader.end();
    expect(read.output).toBeNull();
    expect(read.response.output).toEqual([]);
    expect(read.response.warnings).toEqual([RESPONSE_TOO_LARGE]);
  });

  it("counts the headers events carry, so many of them can't grow it either", () => {
    const reader = new WebSocketResponseReader(LIMIT);
    // Each event names a new header: nothing the rebuilder keeps, all of it held by the reader.
    feed(
      reader,
      Array.from({ length: 500 }, (_, index) =>
        JSON.stringify({ type: "codex.response.metadata", headers: { [`x-h-${index}`]: "v" } }),
      ),
    );
    expect(reader.abandoned).toBe(true);
    expect(reader.end().headers).toEqual({});
  });

  it("counts what it notes along the way: ids, models and errors", () => {
    const reader = new WebSocketResponseReader(LIMIT);
    feed(reader, [
      JSON.stringify({
        type: "response.created",
        response: { id: "r".repeat(3_000), model: "m".repeat(3_000) },
      }),
    ]);
    expect(reader.abandoned).toBe(true);
    const errors = new WebSocketResponseReader(LIMIT);
    feed(errors, [
      JSON.stringify({ type: "error", status: 400, error: { message: "e".repeat(5_000) } }),
    ]);
    expect(errors.abandoned).toBe(true);
  });

  it("holds nothing for events it doesn't keep, however many stream by", () => {
    const reader = new WebSocketResponseReader(LIMIT);
    feed(
      reader,
      Array.from({ length: 1_000 }, () =>
        JSON.stringify({ type: "response.output_text.delta", delta: "z".repeat(100) }),
      ),
    );
    expect(reader.abandoned).toBe(false);
    expect(reader.held).toBe(0);
    // Messages that weren't JSON are noted once.
    feed(
      reader,
      Array.from({ length: 100 }, () => "not json"),
    );
    expect(reader.held).toBeLessThan(100);
  });
});
