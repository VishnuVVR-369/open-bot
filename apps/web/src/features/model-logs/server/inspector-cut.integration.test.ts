// A run with more requests than the inspector lists: it lists the first ones and totals them all,
// and what the last listed calls did after the cut (an outcome reported late, a nested item, what
// the model got back) still shows, while items of the requests left out don't.
import { createHash, randomUUID } from "node:crypto";
import { type ApiClient, MODEL_LOG_RUN_REQUESTS } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { owned } from "@/test/api/seed";

const t0 = Date.now() - 2 * 60 * 60_000;
const at = (seconds: number) => new Date(t0 + seconds * 1000);
const json = (value: unknown) => JSON.stringify(value);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** More requests than the inspector lists, the last three failed. */
const BIG = MODEL_LOG_RUN_REQUESTS + 3;
/** Request k starts at `start(k)`; the first one left out, at `start(MODEL_LOG_RUN_REQUESTS)`. */
const start = (k: number) => k * 0.5;
const CUT = start(MODEL_LOG_RUN_REQUESTS);
const LAST = MODEL_LOG_RUN_REQUESTS - 1;

describe.skipIf(!apiTestUrl)("a run longer than the inspector lists", () => {
  const harness = apiHarness();
  const { ids, database } = harness;
  let api: ApiClient;
  const big = randomUUID();
  const requestIds = Array.from({ length: BIG }, () => randomUUID());

  beforeAll(async () => {
    api = harness.api;
    const s = await import("@open-bot/db");
    const db = database.db;
    await db.insert(s.runs).values({
      id: big,
      chatId: ids.chat,
      ...owned(ids.teammate),
      trigger: "user",
      prompt: "Go",
      status: "completed",
      createdAt: at(0),
      startedAt: at(0),
      completedAt: at(600),
    });
    await db.insert(s.runTurns).values({
      runId: big,
      codexThreadId: "big",
      codexTurnId: "tu-big",
      accessMode: "plan",
      startedAt: at(0),
    });
    await db.insert(s.modelRequests).values(
      requestIds.map((id, k) => ({
        id,
        source: "codex" as const,
        route: "plan" as const,
        transport: "websocket" as const,
        method: "response.create",
        endpoint: "/responses",
        requestHeaders: {},
        teammateId: ids.teammate,
        codexThreadId: "big",
        codexTurnId: "tu-big",
        requestKind: "turn",
        startedAt: at(start(k)),
        firstByteAt: k === LAST ? at(start(k) + 0.1) : null,
        costMicros: 2,
        status: k >= BIG - 3 ? 500 : 200,
      })),
    );

    // The last listed request runs a command and a code-mode cell; the one before it, a command
    // whose messages came late. The first request left out carries what the model got back.
    await db.insert(s.modelToolCalls).values([
      {
        requestId: requestIds[LAST - 1]!,
        position: 0,
        callId: "call_delayed",
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"make"}',
      },
      {
        requestId: requestIds[LAST]!,
        position: 0,
        callId: "call_last",
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"make build"}',
      },
      {
        requestId: requestIds[LAST]!,
        position: 1,
        callId: "exec_last",
        type: "custom_tool_call",
        name: "exec",
        arguments: "await tools.add_task({})",
      },
    ]);
    const outputs = [
      json({ type: "function_call_output", call_id: "call_delayed", output: "made" }),
      json({ type: "function_call_output", call_id: "call_last", output: "last output" }),
      json({
        type: "custom_tool_call_output",
        call_id: "exec_last",
        output: [{ type: "input_text", text: "Script completed\nOutput:\n" }],
      }),
    ];
    await db.insert(s.modelBlobs).values(
      outputs.map((content) => ({
        hash: hash(content),
        kind: "item" as const,
        content,
        bytes: content.length,
      })),
    );
    await db.insert(s.modelRequestItems).values([
      { requestId: requestIds[LAST]!, side: "input", position: 0, blobHash: hash(outputs[0]!) },
      ...outputs.map((content, position) => ({
        requestId: requestIds[MODEL_LOG_RUN_REQUESTS]!,
        side: "input" as const,
        position,
        blobHash: hash(content),
      })),
    ]);

    let sequence = 1;
    const event = (
      method: "item/started" | "item/completed",
      itemId: string,
      seconds: number,
      item: Record<string, unknown>,
      thread = "big",
    ) => ({
      runId: big,
      codexThreadId: thread,
      codexTurnId: "tu-big",
      itemId,
      sequence: sequence++,
      direction: "from_codex" as const,
      kind: "notification" as const,
      method,
      payload: { item: { id: itemId, ...item } },
      at: at(seconds),
    });
    const command = (command: string) => ({ type: "commandExecution", command });
    const done = (command: string, output: string) => ({
      type: "commandExecution",
      command,
      status: "completed",
      exitCode: 0,
      aggregatedOutput: output,
    });
    await db.insert(s.codexEvents).values([
      event("item/completed", "before-the-cut", 1, done("whoami", "kit")),
      // Started before the cut, completed after it.
      event("item/started", "call_last", CUT - 0.2, command("make build")),
      event("item/completed", "call_last", CUT + 0.4, done("make build", "built")),
      // A nested item of the last cell that started before the cut and completed after it, and
      // one that started after the cut, while the cell was still running.
      event("item/started", "nested-crossing", CUT - 0.1, { type: "dynamicToolCall", tool: "a" }),
      // It completed after the cell's window (the cut plus the transit slack) had closed.
      event("item/completed", "nested-crossing", CUT + 5, {
        type: "dynamicToolCall",
        tool: "a",
        status: "completed",
        success: true,
      }),
      event("item/started", "nested-after", CUT + 0.5, command("ls")),
      event("item/completed", "nested-after", CUT + 0.7, done("ls", "a.txt")),
      // A listed call whose messages were reported late, after every listed cell had ended.
      event("item/started", "call_delayed", CUT + 3, command("make")),
      event("item/completed", "call_delayed", CUT + 3.2, done("make", "made")),
      // After the cut, on a thread none of the listed requests are in.
      event("item/started", "elsewhere-after", CUT + 0.5, command("pwd"), "other"),
      // Long after the last listed cell ended: a request that isn't listed made it.
      event("item/started", "after-the-cut", CUT + 10, command("date")),
      event("item/completed", "after-the-cut", CUT + 10.1, done("date", "today")),
    ]);
  });

  it("lists the first requests, with totals over all of them", async () => {
    const logs = await api.modelLogs.run({ runId: big });
    expect(logs.shownRequests).toBe(MODEL_LOG_RUN_REQUESTS);
    expect(logs.turns[0]!.requests).toHaveLength(MODEL_LOG_RUN_REQUESTS);
    expect(logs.turns[0]!.requests.at(-1)!.id).toBe(requestIds[LAST]);
    expect(logs.totals).toMatchObject({ requests: BIG, costMicros: 2 * BIG, errors: 3 });
  });

  it("keeps what the last listed calls did after the cut, and leaves out later requests' items", async () => {
    const logs = await api.modelLogs.run({ runId: big });
    const requests = logs.turns[0]!.requests;
    const calls = new Map(
      requests.flatMap((r) => r.toolCalls).map((call) => [call.callId, call] as const),
    );
    expect(calls.get("call_last")).toMatchObject({
      outcome: { status: "completed", tone: "ok", exitCode: 0, output: "built" },
      returned: { text: "last output" },
    });
    expect(calls.get("call_delayed")).toMatchObject({
      outcome: { status: "completed", exitCode: 0, output: "made" },
      returned: { text: "made" },
    });
    const nested = calls.get("exec_last")!.nested;
    expect(nested.map((n) => [n.itemId, n.status, n.match])).toEqual([
      ["nested-crossing", "completed", "only_candidate"],
      ["nested-after", "completed", "only_candidate"],
    ]);
    expect(calls.get("exec_last")!.returned?.text).toContain("Script completed");
    expect(logs.unlinkedTools.map((o) => o.itemId)).toEqual(["before-the-cut"]);
  });
});
