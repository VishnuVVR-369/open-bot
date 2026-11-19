import { describe, expect, it } from "vitest";
import { rateLimitHeaders, sanitizeHeaders } from "./headers";
import { costMicros } from "../models";
import { requestCostMicros } from "./cost";
import { joinRequestBody, splitRequestBody, turnMetadata } from "./request";

const turn = {
  installation_id: "inst",
  session_id: "019a-session",
  thread_id: "019a-thread",
  turn_id: "019a-turn",
  window_id: "019a-thread:0",
  request_kind: "turn",
};

/** A request body shaped like Codex 0.162.1's `ResponsesApiRequest`. */
const BODY = {
  model: "gpt-6.1-sol",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Rules" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Say pong." }] },
  ],
  tools: [{ type: "function", name: "exec_command", parameters: {} }],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "medium", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "019a-session",
  client_metadata: {
    session_id: "019a-session",
    thread_id: "019a-thread",
    turn_id: "019a-turn",
    "x-codex-turn-metadata": JSON.stringify(turn),
  },
};

describe("splitRequestBody", () => {
  it("takes out the input, instructions and tools, and gives back the same body", () => {
    const split = splitRequestBody(BODY);
    expect(split.model).toBe("gpt-6.1-sol");
    expect(split.input).toHaveLength(2);
    expect(split.instructions).toBe("You are Codex.");
    expect(split.params).not.toHaveProperty("input");
    expect(split.params).toHaveProperty("reasoning", BODY.reasoning);
    expect(joinRequestBody(split)).toEqual(BODY);
  });

  it("leaves a text input and empty parts in the parameters", () => {
    const body = { model: "m", input: "hello", tools: [], instructions: "" };
    const split = splitRequestBody(body);
    expect(split).toMatchObject({ input: null, tools: null, instructions: null });
    expect(joinRequestBody(split)).toEqual(body);
  });
});

describe("turnMetadata", () => {
  it("reads the turn metadata header first", () => {
    expect(
      turnMetadata(
        { "x-codex-turn-metadata": JSON.stringify({ ...turn, request_kind: "compaction" }) },
        {},
      ),
    ).toEqual({ threadId: "019a-thread", turnId: "019a-turn", requestKind: "compaction" });
  });

  it("falls back to the body's client_metadata, as on a WebSocket", () => {
    expect(turnMetadata({}, BODY)).toEqual({
      threadId: "019a-thread",
      turnId: "019a-turn",
      requestKind: "turn",
    });
  });

  it("falls back to the thread-id header when nothing describes the turn", () => {
    expect(turnMetadata({ "Thread-Id": "t1" }, { input: [] })).toEqual({
      threadId: "t1",
      turnId: null,
      requestKind: null,
    });
  });
});

describe("sanitizeHeaders", () => {
  it("drops every credential and the account, and keeps rate limits", () => {
    const headers = {
      Authorization: "Bearer sk-secret",
      cookie: "a=b",
      "x-api-key": "k",
      "openai-organization": "org",
      "chatgpt-account-id": "acct",
      "x-oai-attestation": "att",
      "x-session-token": "t",
      "x-ratelimit-remaining-requests": "99",
      "x-codex-primary-used-percent": "42",
      "retry-after": "3",
      "content-type": "text/event-stream",
      "set-cookie": ["a=1", "b=2"],
    };
    const kept = sanitizeHeaders(headers);
    expect(JSON.stringify(kept)).not.toMatch(/sk-secret|a=b|"k"|att|"t"|acct/);
    expect(kept).toEqual({
      "content-type": "text/event-stream",
      "openai-organization": "org",
      "retry-after": "3",
      "x-codex-primary-used-percent": "42",
      "x-ratelimit-remaining-requests": "99",
    });
    expect(rateLimitHeaders(headers)).toEqual({
      "retry-after": "3",
      "x-codex-primary-used-percent": "42",
      "x-ratelimit-remaining-requests": "99",
    });
  });
});

describe("requestCostMicros", () => {
  const usage = {
    inputTokens: 12_000,
    cachedInputTokens: 2_000,
    outputTokens: 300,
    reasoningTokens: 0,
  };

  it("prices API key requests at list prices", () => {
    // 10,000 uncached at $2, 2,000 cached at $0.10, 300 output at $10, per million.
    expect(requestCostMicros("api", usage)).toBe(20_000 + 200 + 3_000);
  });

  it("agrees with the per-run price usage_entries had, up to rounding each request", () => {
    // A run's requests as Codex reported each one's usage, which the run used to add up and
    // price once (costMicros of the sum). Only cached tokens cost a fraction of a micro.
    const requests = [
      { inputTokens: 12_000, cachedInputTokens: 2_005, outputTokens: 300, reasoningTokens: 0 },
      { inputTokens: 15_000, cachedInputTokens: 12_003, outputTokens: 40, reasoningTokens: 10 },
      { inputTokens: 900, cachedInputTokens: 0, outputTokens: 1_200, reasoningTokens: 0 },
    ];
    const perRequest = requests.reduce((sum, usage) => sum + requestCostMicros("api", usage), 0);
    const perRun = costMicros({
      inputTokens: requests.reduce((sum, usage) => sum + usage.inputTokens, 0),
      cachedInputTokens: requests.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
      outputTokens: requests.reduce((sum, usage) => sum + usage.outputTokens, 0),
    });
    expect(Math.abs(perRequest - perRun)).toBeLessThanOrEqual(requests.length / 2);
    // Whole tens of cached tokens price the same either way.
    const even = requests.map((usage) => ({ ...usage, cachedInputTokens: 500 }));
    expect(even.reduce((sum, usage) => sum + requestCostMicros("api", usage), 0)).toBe(
      costMicros({
        inputTokens: 27_900,
        cachedInputTokens: 1_500,
        outputTokens: 1_540,
      }),
    );
  });

  it("costs nothing on the plan or without usage", () => {
    expect(requestCostMicros("plan", usage)).toBe(0);
    expect(requestCostMicros("api", null)).toBe(0);
  });
});
