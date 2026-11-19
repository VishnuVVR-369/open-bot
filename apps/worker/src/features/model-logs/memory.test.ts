import type { MemoryAIRequest } from "@open-bot/memory/jobs";
import { describe, expect, it } from "vitest";
import { memoryRecord } from "./memory";

const at = new Date("2026-11-17T10:00:00Z");
const call = (patch: Partial<MemoryAIRequest>): MemoryAIRequest => ({
  kind: "extraction",
  url: "https://user:pass@ai.example.com/v1/chat/completions?key=secret",
  body: {},
  status: 200,
  startedAt: at,
  firstByteAt: at,
  endedAt: at,
  response: null,
  error: null,
  ...patch,
});

describe("memoryRecord", () => {
  it("stores an extraction's messages, answer, usage and endpoint without credentials", () => {
    const messages = [
      { role: "system", content: "Extract at most five durable facts." },
      { role: "user", content: "I prefer remote jobs." },
    ];
    const answer = {
      id: "chatcmpl-1",
      model: "gpt-6.1-mini",
      choices: [{ index: 0, message: { role: "assistant", content: '{"memories":[]}' } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const record = memoryRecord(
      call({
        body: { model: "gpt-6.1-mini", temperature: 0, max_tokens: 1200, messages },
        response: JSON.stringify(answer),
      }),
      "req-1",
    );
    expect(record.row).toMatchObject({
      id: "req-1",
      source: "memory",
      route: null,
      transport: "http",
      endpoint: "https://ai.example.com/v1/chat/completions",
      requestKind: "extraction",
      model: "gpt-6.1-mini",
      status: 200,
      inputTokens: 120,
      cachedInputTokens: 64,
      outputTokens: 8,
      stopReason: "completed",
      params: { model: "gpt-6.1-mini", temperature: 0, max_tokens: 1200 },
      responseText: '{"memories":[]}',
      requestHeaders: { "content-type": "application/json" },
    });
    expect(record.items.map((item) => item.side)).toEqual(["input", "input", "output"]);
    expect(JSON.stringify(record)).not.toMatch(/pass|key=secret/);
  });

  it("stores an embedding's text and vector, and a failure", () => {
    const record = memoryRecord(
      call({
        kind: "embedding",
        body: { model: "text-embedding-4", input: "Prefers remote roles" },
        response: JSON.stringify({ data: [{ embedding: [1, 0, 0] }], usage: { prompt_tokens: 4 } }),
      }),
      "req-2",
    );
    expect(record.items.map((item) => item.side)).toEqual(["input", "output"]);
    expect(record.row).toMatchObject({ requestKind: "embedding", inputTokens: 4, outputTokens: 0 });
    const failed = memoryRecord(
      call({ status: 500, response: "upstream broke", error: "Memory AI request failed (500)." }),
      "req-3",
    );
    expect(failed.row).toMatchObject({
      status: 500,
      stopReason: "failed",
      errorMessage: "Memory AI request failed (500).",
      rawResponse: "upstream broke",
      parseWarnings: ["the response was not JSON"],
    });
  });

  it("reads an error envelope's code and message", () => {
    const body = {
      error: {
        message: "You exceeded your current quota.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    };
    const record = memoryRecord(
      call({
        status: 429,
        response: JSON.stringify(body),
        error: "Memory AI request failed (429).",
      }),
      "req-4",
    );
    expect(record.row).toMatchObject({
      status: 429,
      stopReason: "failed",
      errorType: "insufficient_quota",
      errorMessage: "You exceeded your current quota.",
      rawResponse: null,
    });
  });

  it("keeps JSON it doesn't understand as the raw response, cut to size", () => {
    const record = memoryRecord(
      call({ status: 404, response: '{"detail":"Not Found"}', error: "Memory AI failed (404)." }),
      "req-5",
    );
    expect(record.row).toMatchObject({
      errorType: "memory_ai",
      errorMessage: "Memory AI failed (404).",
      rawResponse: '{"detail":"Not Found"}',
    });
    // An error envelope in a shape it can't read keeps its body.
    const detail = '{"error":{"detail":"bad deployment","status":400}}';
    const unread = memoryRecord(
      call({ status: 400, response: detail, error: "Memory AI failed (400)." }),
      "req-7",
    );
    expect(unread.row).toMatchObject({
      stopReason: "failed",
      errorType: "memory_ai",
      errorMessage: "Memory AI failed (400).",
      rawResponse: detail,
    });
    const codeOnly = '{"error":{"code":"deployment_missing","detail":"bad deployment"}}';
    expect(
      memoryRecord(call({ status: 404, response: codeOnly, error: "x" }), "req-8").row,
    ).toMatchObject({ errorType: "deployment_missing", rawResponse: codeOnly });
    const huge = JSON.stringify({ gateway: "x".repeat(2 * 1024 * 1024) });
    const cut = memoryRecord(call({ response: huge }), "req-6");
    expect(cut.row.rawResponse).toHaveLength(1024 * 1024);
    expect(cut.row.parseWarnings).toEqual(["the raw response was cut to fit"]);
  });
});
