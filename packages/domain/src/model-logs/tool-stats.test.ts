import { describe, expect, it } from "vitest";
import { exportLine, rebuildRequestBody } from "./export";
import { outcomeOf } from "./run-view";
import { toolItemFailed, toolNameOf } from "./tool-stats";

describe("toolNameOf", () => {
  it("names tools by their own names, and the rest by kind", () => {
    expect(toolNameOf("dynamicToolCall", { namespace: "tasks", tool: "add_task" })).toBe(
      "tasks.add_task",
    );
    expect(toolNameOf("dynamicToolCall", { tool: "set_chat_title" })).toBe("set_chat_title");
    expect(toolNameOf("mcpToolCall", { server: "github", tool: "create_issue" })).toBe(
      "github.create_issue",
    );
    expect(toolNameOf("commandExecution", { command: "ls" })).toBe("Shell command");
    expect(toolNameOf("fileChange", null)).toBe("File edit");
    expect(toolNameOf("somethingNew", {})).toBe("somethingNew");
  });
});

describe("toolItemFailed", () => {
  const cases: [Record<string, unknown>, boolean][] = [
    [{ status: "completed", exitCode: 0 }, false],
    [{ status: "completed", exitCode: 1 }, true],
    [{ status: "failed" }, true],
    [{ status: "declined" }, true],
    [{ error: { message: "boom" } }, true],
    [{ error: "boom" }, true],
    [{ error: "" }, false],
    [{ error: null, status: "completed" }, false],
    [{ success: false }, true],
    [{ status: "inProgress" }, false],
  ];

  it.each(cases)("%j failed: %s", (item, failed) => {
    expect(toolItemFailed(item)).toBe(failed);
  });

  it("agrees with the run inspector's error tone", () => {
    for (const [item] of cases) {
      const tone = outcomeOf({
        itemId: "i",
        threadId: "t",
        type: "commandExecution",
        at: new Date(),
        completed: true,
        item,
        output: null,
        outputChars: 0,
        omitted: null,
      }).tone;
      expect(tone === "error", JSON.stringify(item)).toBe(toolItemFailed(item));
    }
  });
});

describe("the export", () => {
  const row = {
    id: "r1",
    runId: "run",
    source: "codex",
    route: "plan",
    transport: "websocket",
    method: "response.create",
    endpoint: "/responses",
    teammateId: null,
    codexThreadId: "th",
    codexTurnId: "tu",
    requestKind: "turn",
    model: "gpt-5.5",
    responseId: "resp_1",
    status: 200,
    startedAt: "2026-11-17T00:00:00.000Z",
    firstByteAt: null,
    endedAt: null,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    costMicros: 0,
    stopReason: "completed",
    errorType: null,
    errorMessage: null,
    requestHeaders: {},
    responseHeaders: null,
    rateLimitHeaders: null,
    params: { model: "gpt-5.5", stream: true },
    sentInputFrom: 1,
    responseText: "Hi",
    reasoningSummary: null,
    rawResponse: null,
    parseWarnings: [],
    bodiesExpiredAt: null,
  };
  const bodies = {
    instructions: JSON.stringify("Be brief."),
    tools: JSON.stringify([{ type: "function", name: "ls" }]),
    input: [JSON.stringify({ role: "user", content: "hi" }), null],
    output: [JSON.stringify({ type: "message", content: "Hi" })],
    toolCalls: [],
  };

  it("rebuilds the body in the order it was sent, parameters first", () => {
    const body = rebuildRequestBody({ ...row, ...bodies })!;
    expect(Object.keys(body)).toEqual(["model", "stream", "instructions", "tools", "input"]);
    expect(body.instructions).toBe("Be brief.");
    expect(body.input).toEqual([{ role: "user", content: "hi" }, null]);
  });

  it("writes one line with the request, the response and its numbers", () => {
    const line = exportLine(row, bodies);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed.request.tools).toEqual([{ type: "function", name: "ls" }]);
    expect(parsed.response.output).toEqual([{ type: "message", content: "Hi" }]);
    expect(parsed.usage.input_tokens).toBe(10);
    expect(parsed.sent_input_from).toBe(1);
  });

  it("has no request or response once the bodies expired, and keeps the numbers", () => {
    const parsed = JSON.parse(
      exportLine({ ...row, bodiesExpiredAt: "2026-11-17T01:00:00.000Z" }, bodies),
    );
    expect(parsed.request).toBeNull();
    expect(parsed.response).toBeNull();
    expect(parsed.status).toBe(200);
    expect(parsed.params).toEqual(row.params);
  });
});
