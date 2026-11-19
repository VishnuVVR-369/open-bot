import { createHash, randomUUID } from "node:crypto";
import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { owned } from "@/test/api/seed";

const t0 = Date.now() - 60 * 60_000;
const at = (seconds: number) => new Date(t0 + seconds * 1000);
const json = (value: unknown) => JSON.stringify(value);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!apiTestUrl)("model logs, through the API", () => {
  const harness = apiHarness();
  const { ids, database } = harness;
  let api: ApiClient;
  const logged = randomUUID();
  const fallback = randomUUID();
  const unlogged = randomUUID();
  const request = { prewarm: randomUUID(), first: randomUUID(), second: randomUUID() };
  const apiRequest = randomUUID();

  beforeAll(async () => {
    api = harness.api;
    const s = await import("@open-bot/db");
    const db = database.db;
    const run = (id: string, seconds: number) => ({
      id,
      chatId: ids.chat,
      ...owned(ids.teammate),
      trigger: "user" as const,
      prompt: "List the files",
      status: "completed" as const,
      createdAt: at(seconds),
      startedAt: at(seconds),
      completedAt: at(seconds + 50),
    });
    await db.insert(s.runs).values([run(logged, 0), run(fallback, 100), run(unlogged, 200)]);
    await db.insert(s.runTurns).values([
      {
        runId: logged,
        codexThreadId: "th1",
        codexTurnId: "tu1",
        accessMode: "plan",
        startedAt: at(1),
      },
      {
        runId: fallback,
        codexThreadId: "th2",
        codexTurnId: "tu2",
        accessMode: "plan",
        startedAt: at(101),
      },
      {
        runId: fallback,
        codexThreadId: "th3",
        codexTurnId: "tu3",
        accessMode: "api_key",
        startedAt: at(110),
      },
    ]);

    // The blobs: a user message, a direct shell call and its output, a code-mode exec and its output.
    const items = {
      user: json({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "List the files" }],
      }),
      call: json({
        type: "function_call",
        name: "exec_command",
        call_id: "call_ls",
        arguments: '{"cmd":"ls"}',
      }),
      output: json({ type: "function_call_output", call_id: "call_ls", output: "a.txt\nb.txt" }),
      exec: json({
        type: "custom_tool_call",
        name: "exec",
        call_id: "call_exec",
        input: "await tools.add_task({})",
      }),
      execOutput: json({
        type: "custom_tool_call_output",
        call_id: "call_exec",
        output: [{ type: "input_text", text: "Script completed\nOutput:\n" }],
      }),
      answer: json({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Two files." }],
      }),
      instructions: json("You are Scout."),
      tools: json([{ type: "function", name: "exec_command", description: "Run a command" }]),
    };
    await db.insert(s.modelBlobs).values(
      Object.entries(items).map(([key, content]) => ({
        hash: hash(content),
        kind:
          key === "instructions"
            ? ("instructions" as const)
            : key === "tools"
              ? ("tools" as const)
              : ("item" as const),
        content,
        bytes: content.length,
      })),
    );
    const base = {
      source: "codex" as const,
      route: "plan" as const,
      transport: "websocket" as const,
      method: "response.create",
      endpoint: "/responses",
      model: "gpt-5.5",
      requestHeaders: {},
      teammateId: ids.teammate,
    };
    await db.insert(s.modelRequests).values([
      // A prewarm names no turn: it is placed by time.
      {
        ...base,
        id: request.prewarm,
        codexThreadId: "th1",
        codexTurnId: null,
        requestKind: "prewarm",
        status: 200,
        startedAt: at(1.2),
        endedAt: at(1.4),
      },
      {
        ...base,
        id: request.first,
        codexThreadId: "th1",
        codexTurnId: "tu1",
        requestKind: "turn",
        status: 200,
        startedAt: at(2),
        firstByteAt: at(3),
        endedAt: at(5),
        inputTokens: 1000,
        cachedInputTokens: 600,
        outputTokens: 50,
        instructionsHash: hash(items.instructions),
        toolsHash: hash(items.tools),
        rateLimitHeaders: { "x-codex-primary-used-percent": "12" },
      },
      {
        ...base,
        id: request.second,
        codexThreadId: "th1",
        codexTurnId: "tu1",
        requestKind: "turn",
        status: 200,
        startedAt: at(20),
        firstByteAt: at(21),
        endedAt: at(22),
        inputTokens: 1200,
        cachedInputTokens: 1000,
        outputTokens: 20,
        sentInputFrom: 3,
        responseText: "Two files.",
      },
      // The fallback: a failed plan request, then the API key on a new thread.
      {
        ...base,
        id: randomUUID(),
        codexThreadId: "th2",
        codexTurnId: "tu2",
        requestKind: "turn",
        status: 429,
        errorType: "usage_limit_reached",
        errorMessage: "The plan's limit was reached",
        startedAt: at(102),
      },
      {
        ...base,
        id: apiRequest,
        route: "api",
        transport: "http",
        method: "POST",
        codexThreadId: "th3",
        codexTurnId: "tu3",
        requestKind: "turn",
        status: 200,
        startedAt: at(111),
        endedAt: at(113),
        inputTokens: 900,
        outputTokens: 30,
        costMicros: 2550,
        // Cut off before the API reported its usage.
        usageEstimated: true,
      },
      // Another chat's request on another thread: never part of these runs.
      {
        ...base,
        id: randomUUID(),
        codexThreadId: "elsewhere",
        codexTurnId: "tu1",
        requestKind: "turn",
        status: 200,
        startedAt: at(3),
      },
    ]);
    const item = (
      requestId: string,
      side: "input" | "output",
      position: number,
      content: string,
    ) => ({
      requestId,
      side,
      position,
      blobHash: hash(content),
    });
    await db
      .insert(s.modelRequestItems)
      .values([
        item(request.first, "input", 0, items.user),
        item(request.first, "output", 0, items.call),
        item(request.first, "output", 1, items.exec),
        item(request.second, "input", 0, items.user),
        item(request.second, "input", 1, items.call),
        item(request.second, "input", 2, items.exec),
        item(request.second, "input", 3, items.output),
        item(request.second, "input", 4, items.execOutput),
        item(request.second, "output", 0, items.answer),
      ]);
    await db.insert(s.modelToolCalls).values([
      {
        requestId: request.first,
        position: 0,
        callId: "call_ls",
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"ls"}',
      },
      {
        requestId: request.first,
        position: 1,
        callId: "call_exec",
        type: "custom_tool_call",
        name: "exec",
        arguments: "await tools.add_task({})",
      },
    ]);
    let sequence = 1;
    const event = (method: string, itemId: string | null, seconds: number, payload: unknown) => ({
      runId: logged,
      codexThreadId: "th1",
      codexTurnId: "tu1",
      itemId,
      sequence: sequence++,
      direction: "from_codex" as const,
      kind: "notification" as const,
      method,
      payload,
      at: at(seconds),
    });
    await db.insert(s.codexEvents).values([
      event("turn/started", null, 1.1, { threadId: "th1", turn: { id: "tu1" } }),
      event("item/started", "call_ls", 4, {
        item: { type: "commandExecution", id: "call_ls", command: "ls", status: "inProgress" },
      }),
      event("item/completed", "call_ls", 4.2, {
        item: {
          type: "commandExecution",
          id: "call_ls",
          command: "ls",
          status: "completed",
          exitCode: 0,
          durationMs: 41,
          aggregatedOutput: "a.txt\nb.txt",
        },
      }),
      event("item/started", "exec-1", 4.5, {
        item: { type: "dynamicToolCall", id: "exec-1", tool: "add_task", status: "inProgress" },
      }),
      event("item/completed", "exec-1", 4.6, {
        item: {
          type: "dynamicToolCall",
          id: "exec-1",
          tool: "add_task",
          status: "completed",
          success: true,
          contentItems: [{ type: "inputText", text: "Added" }],
        },
      }),
      // Too large to store: only a note was kept.
      event("item/completed", "exec-2", 30, { omitted: "it was too large", size: 3_000_000 }),
    ]);
  });

  it("refuses every read without the owner's session", async () => {
    const { auth } = await import("@/lib/server/auth");
    const getSession = vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    try {
      const reads = [
        () => api.modelLogs.runs({}),
        () => api.modelLogs.run({ runId: logged }),
        () => api.modelLogs.request({ requestId: request.first }),
        () => api.modelLogs.events({ runId: logged }),
        () => api.modelLogs.event({ eventId: randomUUID() }),
      ];
      for (const read of reads)
        await expect(read()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      getSession.mockRestore();
    }
  });

  it("lists runs with logs, newest first, with their requests' tokens, cost and errors", async () => {
    const { runs, nextBefore } = await api.modelLogs.runs({});
    expect(nextBefore).toBeNull();
    expect(runs.map((r) => r.runId)).toEqual([fallback, logged]);
    expect(runs[0]).toMatchObject({
      requests: 2,
      errors: 1,
      costMicros: 2550,
      teammateName: "Scout",
    });
    expect(runs[1]).toMatchObject({
      requests: 3,
      errors: 0,
      inputTokens: 2200,
      cachedInputTokens: 1600,
      outputTokens: 70,
      chatTitle: "Scout",
    });
  });

  it("says plainly when a run has no logs, and that a missing run is gone", async () => {
    const logs = await api.modelLogs.run({ runId: unlogged });
    expect(logs).toMatchObject({
      turns: [],
      events: 0,
      totals: { requests: 0, estimated: false },
    });
    await expect(api.modelLogs.run({ runId: randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.modelLogs.request({ requestId: randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("shows a run's requests in order, a prewarm by time, and each tool call with its outcome", async () => {
    const logs = await api.modelLogs.run({ runId: logged });
    expect(logs.events).toBe(6);
    expect(logs.turns).toHaveLength(1);
    const [prewarm, first, second] = logs.turns[0]!.requests;
    expect([prewarm!.id, first!.id, second!.id]).toEqual([
      request.prewarm,
      request.first,
      request.second,
    ]);
    expect(prewarm).toMatchObject({ kind: "prewarm", turnMatch: "time" });
    expect(first).toMatchObject({
      turnMatch: "turn",
      inputItems: 1,
      outputItems: 2,
      rateLimits: { "x-codex-primary-used-percent": "12" },
    });
    const [shell, exec] = first!.toolCalls;
    expect(shell).toMatchObject({
      name: "exec_command",
      outcome: {
        itemId: "call_ls",
        exitCode: 0,
        durationMs: 41,
        tone: "ok",
        output: "a.txt\nb.txt",
      },
      returned: { text: "a.txt\nb.txt" },
      nested: [],
    });
    expect(exec).toMatchObject({
      name: "exec",
      outcome: null,
      returned: { text: "Script completed\nOutput:\n" },
    });
    expect(exec!.nested).toMatchObject([
      {
        itemId: "exec-1",
        title: "add_task",
        match: "only_candidate",
        candidates: 1,
        output: "Added",
      },
    ]);
    // The item whose message was too large is kept apart, not claimed by a call.
    expect(logs.unlinkedTools).toEqual([]);
  });

  it("shows a fallback as two turns, the second on the API key", async () => {
    const logs = await api.modelLogs.run({ runId: fallback });
    expect(logs.turns.map((t) => [t.accessMode, t.requests.length])).toEqual([
      ["plan", 1],
      ["api_key", 1],
    ]);
    expect(logs.turns[0]!.requests[0]).toMatchObject({ failed: true, status: 429 });
    expect(logs.turns[1]!.requests[0]).toMatchObject({
      id: apiRequest,
      costMicros: 2550,
      usageEstimated: true,
    });
    expect(logs.totals).toMatchObject({
      requests: 2,
      errors: 1,
      costMicros: 2550,
      estimated: true,
    });
  });

  it("rebuilds a request's input in order from its blobs, labeled, with its instructions and tools", async () => {
    const first = await api.modelLogs.request({ requestId: request.first });
    expect(first.instructions).toBe("You are Scout.");
    expect(first.tools.map((t) => t.name)).toEqual(["exec_command"]);
    expect(first.output.map((o) => o.label)).toEqual([
      "Tool call: exec_command",
      "Tool call: exec",
    ]);

    const second = await api.modelLogs.request({ requestId: request.second });
    expect(second.input.map((i) => [i.position, i.label, i.sent])).toEqual([
      [0, "User", false],
      [1, "Tool call: exec_command", false],
      [2, "Tool call: exec", false],
      [3, "Tool output", true],
      [4, "Tool output", true],
    ]);
    expect(second.missingInput).toEqual([]);
    expect(second.output[0]).toMatchObject({ kind: "assistant", text: "Two files." });
    expect(second.responseText).toBe("Two files.");
  });

  it("lists a run's Codex messages without payloads, and opens one, a stub plainly", async () => {
    const events = await api.modelLogs.events({ runId: logged });
    expect(events.map((e) => e.method)).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "item/started",
      "item/completed",
      "item/completed",
    ]);
    expect(events[5]).toMatchObject({ omitted: "it was too large", size: 3_000_000 });
    const { payload } = await api.modelLogs.event({ eventId: events[2]!.id });
    expect(JSON.parse(payload)).toMatchObject({ item: { exitCode: 0 } });
  });
});
