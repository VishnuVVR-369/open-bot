import { describe, expect, it } from "vitest";
import { type ExportedRequestRow, exportLine, rebuildRequestBody, requestShape } from "./export";
import { splitRequestBody } from "./request";

const json = (value: unknown) => JSON.stringify(value);

/** What a Codex request stores of a body: its parameters, blobs and items, as text. */
function stored(body: Record<string, unknown>) {
  const split = splitRequestBody(body);
  return {
    params: split.params,
    instructions: split.instructions === null ? null : json(split.instructions),
    tools: split.tools === null ? null : json(split.tools),
    input: (split.input ?? []).map(json),
  };
}

const codex = { source: "codex", requestKind: "turn", endpoint: "/v1/responses" };

describe("rebuildRequestBody", () => {
  it("gives back a Responses body with a list of input items", () => {
    const body = {
      model: "gpt-5.5",
      instructions: "Be brief.",
      tools: [{ type: "function", name: "shell" }],
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    };
    expect(rebuildRequestBody({ ...codex, ...stored(body) })).toEqual(body);
  });

  it("keeps a Responses input that isn't a list as it was sent", () => {
    const body = { model: "gpt-5", input: "private retention example" };
    expect(rebuildRequestBody({ ...codex, ...stored(body) })).toEqual(body);
  });

  it("puts a chat completion's items back under messages", () => {
    const messages = [
      { role: "system", content: "Extract facts." },
      { role: "user", content: "I moved to Lisbon." },
    ];
    const rebuilt = rebuildRequestBody({
      source: "memory",
      requestKind: "extraction",
      endpoint: "https://api.openai.com/v1/chat/completions",
      params: { model: "gpt-5-mini", response_format: { type: "json_object" } },
      instructions: null,
      tools: null,
      input: messages.map(json),
    });
    expect(rebuilt).toEqual({
      model: "gpt-5-mini",
      response_format: { type: "json_object" },
      messages,
    });
  });

  it("gives an embedding back its one string, or its list", () => {
    const embedding = {
      source: "memory",
      requestKind: "embedding",
      endpoint: "https://api.openai.com/v1/embeddings",
      params: { model: "text-embedding-3-small", dimensions: 1536 },
      instructions: null,
      tools: null,
    };
    expect(rebuildRequestBody({ ...embedding, input: [json("I moved to Lisbon.")] })).toEqual({
      model: "text-embedding-3-small",
      dimensions: 1536,
      input: "I moved to Lisbon.",
    });
    expect(rebuildRequestBody({ ...embedding, input: [json("one"), json("two")] })).toEqual({
      model: "text-embedding-3-small",
      dimensions: 1536,
      input: ["one", "two"],
    });
  });

  it("is null when nothing of the body was stored", () => {
    expect(
      rebuildRequestBody({ ...codex, params: null, instructions: null, tools: null, input: [] }),
    ).toBeNull();
  });

  it("tells shapes apart by endpoint, and for memory by what it did", () => {
    expect(requestShape({ source: "codex", requestKind: null, endpoint: "/v1/responses" })).toBe(
      "responses",
    );
    expect(
      requestShape({
        source: "memory",
        requestKind: "embedding",
        endpoint: "http://x/embeddings/",
      }),
    ).toBe("embedding");
    expect(
      requestShape({ source: "memory", requestKind: "extraction", endpoint: "http://x/v1/chat" }),
    ).toBe("messages");
  });
});

describe("exportLine", () => {
  const row: ExportedRequestRow = {
    id: "r1",
    runId: null,
    source: "codex",
    route: "api",
    transport: "http",
    method: "POST",
    endpoint: "/v1/responses",
    teammateId: null,
    codexThreadId: null,
    codexTurnId: null,
    requestKind: "turn",
    model: "gpt-5",
    responseId: "resp_1",
    status: 200,
    startedAt: "2026-11-01T00:00:00.000Z",
    firstByteAt: null,
    endedAt: null,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    costMicros: 5,
    stopReason: null,
    errorType: null,
    errorMessage: null,
    requestHeaders: {},
    responseHeaders: null,
    rateLimitHeaders: null,
    params: { model: "gpt-5", input: "private retention example", reasoning: { effort: "high" } },
    sentInputFrom: null,
    responseText: "private answer",
    reasoningSummary: null,
    rawResponse: null,
    parseWarnings: [],
    bodiesExpiredAt: null,
  };
  const bodies = {
    instructions: null,
    tools: null,
    input: [],
    output: [],
    toolCalls: [{ callId: "c1", type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' }],
  };

  it("exports a scalar input request as it was sent", () => {
    const line = JSON.parse(exportLine(row, bodies)) as Record<string, unknown>;
    expect(line.request).toEqual({
      model: "gpt-5",
      input: "private retention example",
      reasoning: { effort: "high" },
    });
  });

  it("says an expired request expired, and never brings back what was removed", () => {
    const text = exportLine({ ...row, bodiesExpiredAt: "2026-11-10T00:00:00.000Z" }, bodies);
    const line = JSON.parse(text) as Record<string, unknown>;
    expect(line.bodies_expired_at).toBe("2026-11-10T00:00:00.000Z");
    expect(line.request).toBeNull();
    expect(line.response).toBeNull();
    expect(line.params).toEqual({ model: "gpt-5", reasoning: { effort: "high" } });
    expect(text).not.toContain("private");
    expect(text).not.toContain("cmd");
  });
});
