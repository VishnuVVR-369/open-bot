import { gzipSync } from "node:zlib";
import { costMicros, type RebuiltResponse, USAGE_ESTIMATE } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import { countedUsage, type Exchange, lostRequestOf } from "./capture";
import { newExchange } from "./proxy";

const START = new Date("2026-11-18T10:00:00Z");
const after = (ms: number) => new Date(START.getTime() + ms);
const body = { model: "gpt-6.1-sol", input: "x".repeat(20_000), stream: true };

/** An API key POST that reached the upstream, with `fields` as it ended. */
const exchange = (fields: Partial<Exchange> = {}, route: "api" | "plan" = "api"): Exchange => ({
  ...newExchange({
    route,
    transport: "http",
    method: "POST",
    endpoint: "/responses",
    requestHeaders: { "content-type": "application/json" },
  }),
  requestBody: Buffer.from(JSON.stringify(body)),
  requestBytes: JSON.stringify(body).length,
  sent: true,
  startedAt: START,
  endedAt: after(2_000),
  ...fields,
});
const answered = { status: 200, responseHeaders: { "content-type": "text/event-stream" } };
const response = (fields: Partial<RebuiltResponse>) =>
  ({
    text: "",
    output: [],
    deltaBytes: 0,
    usage: null,
    warnings: [],
    ...fields,
  }) as RebuiltResponse;
const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
/** The request's input at 2 bytes a token: its body, which is all JSON text. */
const inputTokens = Math.ceil(JSON.stringify(body).length / USAGE_ESTIMATE.bytesPerToken);

describe("the usage a request counts", () => {
  it("is what the API reported, when it did", () => {
    const counted = countedUsage(exchange({ ...answered, response: response({ usage }) }), START);
    expect(counted).toEqual({ usage, estimated: false });
  });

  it("is estimated high for a stream cut off before its usage", () => {
    const cutOff = exchange({ ...answered, response: response({ text: "y".repeat(8_000) }) });
    const counted = countedUsage(cutOff, cutOff.endedAt);
    expect(counted).toEqual({
      estimated: true,
      usage: {
        inputTokens,
        cachedInputTokens: 0,
        // What streamed (4,000 tokens) is more than 2 seconds of writing (500).
        outputTokens: 4_000,
        reasoningTokens: 0,
      },
    });
    expect(lostRequestOf(cutOff, cutOff.endedAt)).toEqual({
      startedAt: START,
      route: "api",
      costMicros: costMicros(counted.usage!),
      estimated: true,
    });
  });

  it("is estimated high for a successful answer whose body couldn't be read", () => {
    const unreadable = exchange({ ...answered, response: null });
    expect(countedUsage(unreadable, unreadable.endedAt)).toMatchObject({
      estimated: true,
      usage: { inputTokens, outputTokens: 500 },
    });
  });

  it("is estimated high for a request cancelled or cut off before any answer", () => {
    // Codex cancelled it after 10 seconds, or the proxy's own 502 (no upstream headers) ended it.
    for (const ended of [
      exchange({ endedAt: after(10_000) }),
      exchange({ endedAt: after(10_000), status: 502, failure: { type: "x", message: "x" } }),
    ])
      expect(countedUsage(ended, ended.endedAt)).toMatchObject({
        estimated: true,
        usage: { inputTokens, outputTokens: 2_500 },
      });
  });

  it("is estimated until now for a request still running", () => {
    const running = exchange();
    expect(lostRequestOf(running, after(60_000)).costMicros).toBe(
      costMicros({ inputTokens, cachedInputTokens: 0, outputTokens: 15_000 }),
    );
  });

  it("counts the largest input when the body's size can't be known", () => {
    const compressed = exchange({
      requestHeaders: { "content-encoding": "gzip" },
      requestBody: null,
      requestBytes: gzipSync(JSON.stringify(body)).length,
    });
    expect(countedUsage(compressed, compressed.endedAt).usage?.inputTokens).toBe(
      USAGE_ESTIMATE.maxInputTokens,
    );
    // Kept, it is read through its encoding.
    const kept = exchange({
      requestHeaders: { "content-encoding": "gzip" },
      requestBody: gzipSync(JSON.stringify(body)),
    });
    expect(countedUsage(kept, kept.endedAt).usage?.inputTokens).toBe(inputTokens);
  });

  it("is nothing for a request that never reached the upstream, or that it refused", () => {
    const unsent = exchange({ sent: false, status: 502 });
    expect(countedUsage(unsent, unsent.endedAt)).toEqual({ usage: null, estimated: false });
    const refused = exchange({ status: 429, responseHeaders: {}, response: response({}) });
    expect(countedUsage(refused, refused.endedAt)).toEqual({ usage: null, estimated: false });
    // A refusal after the model wrote something was charged for it.
    const failed = exchange({
      status: 500,
      responseHeaders: {},
      response: response({ text: "a" }),
    });
    expect(countedUsage(failed, failed.endedAt).estimated).toBe(true);
  });

  it("is nothing on the plan, which is a flat subscription", () => {
    const plan = exchange({}, "plan");
    expect(countedUsage(plan, plan.endedAt)).toEqual({ usage: null, estimated: false });
    expect(
      lostRequestOf(exchange({ ...answered, response: response({ usage }) }, "plan"), START),
    ).toMatchObject({ route: "plan", costMicros: 0, estimated: false });
  });
});
