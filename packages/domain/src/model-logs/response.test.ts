import { describe, expect, it } from "vitest";
import { rebuildResponse, ResponseReader, SseDecoder } from "./response";

/** An SSE body the way Codex's own test server writes one (`sse()` in core/tests/common). */
function sse(events: Record<string, unknown>[]): string {
  return events
    .map((event) =>
      Object.keys(event).length === 1
        ? `event: ${String(event.type)}\n\n`
        : `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "Planning the listing." }],
  encrypted_content: "YmJi",
};
const call = {
  type: "function_call",
  call_id: "call_9",
  name: "exec_command",
  arguments: '{"cmd":"ls"}',
};
const message = {
  type: "message",
  role: "assistant",
  id: "msg_1",
  content: [{ type: "output_text", text: "Here are the files." }],
};

/** A turn as the Responses API streams it: deltas, then each item, then the final response. */
const STREAM = sse([
  { type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol" } },
  { type: "response.in_progress", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
  { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "Planning" },
  { type: "response.output_item.done", output_index: 0, item: reasoning },
  { type: "response.output_item.done", output_index: 1, item: call },
  { type: "response.output_text.delta", delta: "Here are" },
  { type: "response.output_item.done", output_index: 2, item: message },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: {
        input_tokens: 12_000,
        input_tokens_details: { cached_tokens: 2_000 },
        output_tokens: 300,
        output_tokens_details: { reasoning_tokens: 120 },
        total_tokens: 12_300,
      },
    },
  },
]);

describe("rebuildResponse", () => {
  it("rebuilds a streamed turn: items in order, text, summary and usage", () => {
    const rebuilt = rebuildResponse(STREAM, "text/event-stream");
    expect(rebuilt).toMatchObject({
      stream: true,
      complete: true,
      responseId: "resp_1",
      model: "gpt-6.1-sol",
      output: [reasoning, call, message],
      text: "Here are the files.",
      reasoningSummary: "Planning the listing.",
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 2_000,
        outputTokens: 300,
        reasoningTokens: 120,
      },
      stopReason: "completed",
      error: null,
      warnings: [],
    });
  });

  it("keeps the encrypted reasoning, so the request can be sent again exactly", () => {
    const rebuilt = rebuildResponse(STREAM, "text/event-stream");
    expect(rebuilt.output[0]).toHaveProperty("encrypted_content", "YmJi");
  });

  it("orders items by output_index when they finish out of order", () => {
    const body = sse([
      { type: "response.output_item.done", output_index: 1, item: message },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.completed", response: { id: "r" } },
    ]);
    expect(rebuildResponse(body, "text/event-stream").output).toEqual([reasoning, message]);
  });

  it("reads Codex's fixtures, where null token details and data-less events appear", () => {
    const body = sse([
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_text.done" },
      { type: "response.output_item.done", item: message },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          usage: {
            input_tokens: 7,
            input_tokens_details: null,
            output_tokens: 3,
            output_tokens_details: null,
            total_tokens: 10,
          },
        },
      },
    ]);
    expect(rebuildResponse(body, null)).toMatchObject({
      complete: true,
      usage: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 0 },
      text: "Here are the files.",
    });
  });

  it("marks an incomplete response with its reason", () => {
    const body = sse([
      {
        type: "response.incomplete",
        response: {
          id: "r",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ]);
    expect(rebuildResponse(body, "text/event-stream").stopReason).toBe(
      "incomplete:max_output_tokens",
    );
  });

  it("keeps the error of a failed response", () => {
    const body = sse([
      {
        type: "response.failed",
        response: {
          id: "r",
          status: "failed",
          error: { code: "rate_limit_exceeded", message: "Rate limit reached for gpt-6.1-sol" },
        },
      },
    ]);
    expect(rebuildResponse(body, "text/event-stream")).toMatchObject({
      complete: true,
      stopReason: "failed",
      error: { type: "rate_limit_exceeded", message: "Rate limit reached for gpt-6.1-sol" },
    });
  });

  it("keeps the items of a stream cut short, and says it was cut", () => {
    const cut = sse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
    ]);
    const rebuilt = rebuildResponse(`${cut}event: response.output_item.done\ndata: {"type":`, null);
    expect(rebuilt.complete).toBe(false);
    expect(rebuilt.output).toEqual([reasoning]);
    expect(rebuilt.warnings).toEqual([
      "an event (response.output_item.done) was not JSON",
      "the stream ended before the response did",
    ]);
  });

  it("reads an error answered as JSON, like a plan's usage limit", () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
    });
    expect(rebuildResponse(body, "application/json")).toMatchObject({
      stream: false,
      complete: true,
      error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
    });
  });

  it("leaves JSON it doesn't understand unread, so the caller keeps it as it came", () => {
    // What Codex's `alpha/search` answers: successful, but not a Responses API response.
    const body = JSON.stringify({ output: "search result", results: [{ type: "text_result" }] });
    expect(rebuildResponse(body, "application/json")).toMatchObject({
      parsed: false,
      output: [],
      warnings: ["the response was JSON, but not a Responses API response"],
    });
  });

  it("reads a whole JSON response", () => {
    const body = JSON.stringify({
      object: "response",
      id: "resp_3",
      model: "gpt-6.1-sol",
      status: "completed",
      output: [message],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(rebuildResponse(body, "application/json")).toMatchObject({
      complete: true,
      output: [message],
      text: "Here are the files.",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });
});

describe("ResponseReader", () => {
  it("gives the same answer whatever the chunks, even split inside a character", () => {
    const bytes = new TextEncoder().encode(
      STREAM.replace("files", "fichiers é ✓").replaceAll("\n", "\r\n"),
    );
    const whole = new ResponseReader("text/event-stream");
    whole.push(bytes);
    const expected = whole.end();
    for (const size of [1, 2, 7, 64]) {
      const reader = new ResponseReader(null);
      for (let at = 0; at < bytes.length; at += size) reader.push(bytes.subarray(at, at + size));
      expect(reader.end(), `chunks of ${size}`).toEqual(expected);
    }
    expect(expected.text).toBe("Here are the fichiers é ✓.");
  });

  it("gives up on a JSON body past its limit instead of keeping it", () => {
    const reader = new ResponseReader("application/json", 10);
    reader.push(
      new TextEncoder().encode(JSON.stringify({ error: { message: "too long to keep" } })),
    );
    expect(reader.end()).toMatchObject({
      parsed: false,
      warnings: ["the response was too large to read"],
    });
  });
});

describe("ResponseReader's limit", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("lets go of an event stream whose unfinished line passes the limit", () => {
    const reader = new ResponseReader("text/event-stream", 1024);
    reader.push(encode(sse([{ type: "response.created", response: { id: "r" } }])));
    // A line that never ends: an event far larger than anything Codex sends.
    for (let at = 0; at < 100; at++) {
      reader.push(encode(`${at ? "" : "data: "}${"x".repeat(1000)}`));
      expect(reader.held).toBeLessThanOrEqual(1024 + 1000);
    }
    expect(reader.abandoned).toBe(true);
    expect(reader.held).toBe(0);
    expect(reader.end()).toMatchObject({
      stream: true,
      parsed: false,
      responseId: null,
      output: [],
      warnings: ["the response was too large to read"],
    });
  });

  it("counts empty data lines, which hold a place each without any characters", () => {
    const reader = new ResponseReader("text/event-stream", 1024);
    reader.push(encode("event: response.output_text.delta\n"));
    for (let at = 0; at < 1000 && !reader.abandoned; at++)
      reader.push(encode("data:\n".repeat(100)));
    expect(reader.abandoned).toBe(true);
    expect(reader.end().warnings).toEqual(["the response was too large to read"]);
  });

  it("notes only the first events that weren't JSON, and counts what it noted", () => {
    const reader = new ResponseReader("text/event-stream", 4096);
    reader.push(encode("event: e0\ndata: {\n\n"));
    expect(reader.held).toBeGreaterThan(0);
    for (let at = 1; at < 1000; at++)
      reader.push(encode(`event: e${at}-${"n".repeat(500)}\ndata: {\n\n`));
    expect(reader.abandoned).toBe(false);
    expect(reader.held).toBeLessThanOrEqual(4096);
    const { warnings } = reader.end();
    expect(warnings).toHaveLength(12);
    expect(warnings[0]).toBe("an event (e0) was not JSON");
    expect(warnings[1]).toBe(`an event (e1-${"n".repeat(97)}) was not JSON`);
    expect(warnings.slice(10)).toEqual([
      "more events were not JSON",
      "the stream ended before the response did",
    ]);
  });

  it("counts the strings it keeps from events it otherwise drops", () => {
    const reader = new ResponseReader("text/event-stream", 1024);
    reader.push(encode(sse([{ type: "response.created", response: { id: "r".repeat(2000) } }])));
    expect(reader.abandoned).toBe(true);
  });

  it("counts the items it keeps, not the deltas it reads past", () => {
    const item = { ...message, content: [{ type: "output_text", text: "y".repeat(300) }] };
    const deltas = Array.from({ length: 50 }, () => ({
      type: "response.output_text.delta",
      delta: "z".repeat(300),
    }));
    // About 16 KB of deltas pass through a 2 KB limit: only what is kept counts.
    const small = new ResponseReader("text/event-stream", 2048);
    small.push(encode(sse([...deltas, { type: "response.output_item.done", item }])));
    expect(small.abandoned).toBe(false);
    // Items pile up past it.
    const many = new ResponseReader("text/event-stream", 2048);
    for (let at = 0; at < 10; at++)
      many.push(encode(sse([{ type: "response.output_item.done", output_index: at, item }])));
    expect(many.abandoned).toBe(true);
    expect(many.end().output).toEqual([]);
  });
});

describe("SseDecoder", () => {
  it("joins multi-line data, skips comments and keeps the last event without a blank line", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(": keep-alive\n\nevent: a\ndata: 1\ndata: 2\n\nevent: b\ndata:3")).toEqual([
      { event: "a", data: "1\n2" },
    ]);
    expect(decoder.end()).toEqual([{ event: "b", data: "3" }]);
  });
});
