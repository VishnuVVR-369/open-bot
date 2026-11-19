import { describe, expect, it } from "vitest";
import {
  outcomeOf,
  placeRequests,
  type PlacedRequestRow,
  retriesOf,
  runTools,
  type ToolCallRow,
  type ToolItemRow,
} from "./run-view";

const t0 = Date.parse("2026-11-17T10:00:00Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000);

const req = (
  id: string,
  seconds: number,
  fields: Partial<PlacedRequestRow> = {},
): PlacedRequestRow => ({
  id,
  threadId: "th1",
  turnId: "tu1",
  placedTurnId: fields.turnId === undefined ? "tu1" : fields.turnId,
  requestKind: "turn",
  startedAt: at(seconds),
  status: 200,
  errorType: null,
  errorMessage: null,
  ...fields,
});

describe("placeRequests", () => {
  const turns = [
    { threadId: "th1", turnId: "tu1", startedAt: at(0) },
    { threadId: "th2", turnId: "tu2", startedAt: at(60) },
  ];

  it("places requests by thread and turn, a fallback's under its second turn", () => {
    const placed = placeRequests(turns, [
      req("b", 70, { threadId: "th2", turnId: "tu2" }),
      req("a2", 20),
      req("a1", 5),
    ]);
    expect(placed.map((p) => [p.request.id, p.turn, p.match])).toEqual([
      ["a1", 0, "turn"],
      ["a2", 0, "turn"],
      ["b", 1, "turn"],
    ]);
  });

  it("places a prewarm, which names no turn, where it was placed by time, and says so", () => {
    const placed = placeRequests(turns, [
      req("prewarm", 0.4, { turnId: null, placedTurnId: "tu1", requestKind: "prewarm" }),
      req("late", 61, { threadId: "th2", turnId: null, placedTurnId: "tu2" }),
    ]);
    expect(placed.map((p) => [p.request.id, p.turn, p.match])).toEqual([
      ["prewarm", 0, "time"],
      ["late", 1, "time"],
    ]);
  });

  it("leaves out requests of other turns, threads, or placed in no turn", () => {
    expect(
      placeRequests(turns, [
        req("other-turn", 5, { turnId: "elsewhere" }),
        req("other-thread", 5, { threadId: "th9" }),
        req("unplaced", -60, { turnId: null, placedTurnId: null }),
        // Placed in another run's turn of the same thread.
        req("other-run", 70, { turnId: null, placedTurnId: "tu-next" }),
        req("no-thread", 5, { threadId: null }),
      ]),
    ).toEqual([]);
  });
});

describe("retriesOf", () => {
  it("marks a request after a failed one of the same turn and kind as its retry", () => {
    const placed = placeRequests(
      [{ threadId: "th1", turnId: "tu1", startedAt: at(0) }],
      [
        req("failed", 1, { status: 503, errorMessage: "upstream unavailable" }),
        req("retry", 3),
        req("next", 10),
        req("compaction", 12, { requestKind: "compaction" }),
      ],
    );
    expect([...retriesOf(placed)]).toEqual([["retry", "failed"]]);
  });

  it("counts a request that never got an answer as failed", () => {
    const placed = placeRequests(
      [{ threadId: "th1", turnId: "tu1", startedAt: at(0) }],
      [req("lost", 1, { status: null }), req("again", 2)],
    );
    expect(retriesOf(placed).get("again")).toBe("lost");
  });
});

const itemRow = (
  itemId: string,
  seconds: number,
  type: string,
  item: Record<string, unknown>,
  fields: Partial<ToolItemRow> = {},
): ToolItemRow => ({
  itemId,
  threadId: "th1",
  type,
  at: at(seconds),
  completed: true,
  item,
  output: null,
  outputChars: 0,
  omitted: null,
  ...fields,
});

describe("outcomeOf", () => {
  it("reads a command's exit code, status and duration", () => {
    expect(
      outcomeOf(
        itemRow(
          "c1",
          1,
          "commandExecution",
          { command: "ls -la", status: "completed", exitCode: 0, durationMs: 41 },
          { output: "a.txt", outputChars: 5 },
        ),
      ),
    ).toMatchObject({
      title: "ls -la",
      status: "completed",
      tone: "ok",
      exitCode: 0,
      durationMs: 41,
      output: "a.txt",
    });
    expect(
      outcomeOf(
        itemRow("c2", 1, "commandExecution", { command: "false", status: "failed", exitCode: 1 }),
      ),
    ).toMatchObject({ tone: "error", exitCode: 1 });
  });

  it("reads an MCP tool's error and a dynamic tool's failure", () => {
    expect(
      outcomeOf(
        itemRow("m1", 1, "mcpToolCall", {
          server: "github",
          tool: "search",
          status: "failed",
          error: { message: "user rejected MCP tool call" },
        }),
      ),
    ).toMatchObject({
      title: "github.search",
      tone: "error",
      error: "user rejected MCP tool call",
    });
    expect(
      outcomeOf(
        itemRow("d1", 1, "dynamicToolCall", {
          tool: "add_task",
          status: "completed",
          success: false,
        }),
      ),
    ).toMatchObject({ title: "add_task", tone: "error" });
  });

  it("names a file change by its paths, and a started item as still working", () => {
    expect(
      outcomeOf(
        itemRow("f1", 1, "fileChange", { paths: ["src/a.ts", "src/b.ts"] }, { completed: false }),
      ),
    ).toMatchObject({ title: "src/a.ts, src/b.ts", status: "started", tone: "working" });
  });

  it("says plainly when an item's result was too large to store", () => {
    expect(
      outcomeOf(
        itemRow(
          "c3",
          1,
          "commandExecution",
          { command: "cat big.log" },
          {
            completed: false,
            omitted: "too large",
          },
        ),
      ),
    ).toMatchObject({ tone: "unknown", omitted: "too large", status: null });
  });
});

describe("runTools", () => {
  const call = (
    requestId: string,
    position: number,
    callId: string,
    name: string,
    type = "function_call",
  ): ToolCallRow => ({ requestId, position, callId, type, name, namespace: null, arguments: "{}" });
  const request = (
    id: string,
    startedAt: number,
    firstByteAt: number,
    outputs: [string, string][] = [],
    threadId = "th1",
  ) => ({
    id,
    threadId,
    startedAt: at(startedAt),
    firstByteAt: at(firstByteAt),
    outputs: outputs.map(([callId, text]) => ({ callId, text })),
  });

  it("joins a direct call to its item exactly, with what the model got back", () => {
    const view = runTools(
      [request("r1", 0, 1), request("r2", 5, 6, [["call_ls", "a.txt\n"]])],
      [call("r1", 0, "call_ls", "exec_command")],
      [
        itemRow("call_ls", 2, "commandExecution", {
          command: "ls",
          status: "completed",
          exitCode: 0,
        }),
      ],
    );
    const [only] = view.calls.get("r1")!;
    expect(only).toMatchObject({
      callId: "call_ls",
      outcome: { itemId: "call_ls", exitCode: 0, tone: "ok" },
      returned: { callId: "call_ls", text: "a.txt\n" },
      nested: [],
    });
    expect(view.unlinked).toEqual([]);
  });

  it("links an exec call's nested items by time, marked as inferred", () => {
    const done = "Script completed\nOutput:\n";
    const view = runTools(
      [request("r1", 0, 1), request("r2", 8, 9, [["exec_1", done]])],
      [call("r1", 0, "exec_1", "exec", "custom_tool_call")],
      [
        itemRow("exec-aaa", 2, "commandExecution", {
          command: "ls",
          status: "completed",
          exitCode: 0,
        }),
        itemRow("exec-bbb", 3, "dynamicToolCall", { tool: "add_task", status: "completed" }),
      ],
    );
    const [exec] = view.calls.get("r1")!;
    expect(exec!.outcome).toBeNull();
    expect(exec!.nested.map((n) => [n.itemId, n.match, n.candidates])).toEqual([
      ["exec-aaa", "only_candidate", 1],
      ["exec-bbb", "only_candidate", 1],
    ]);
  });

  it("lists an item two exec cells could have made under both, as ambiguous", () => {
    const view = runTools(
      [request("r1", 0, 1)],
      [
        call("r1", 0, "exec_1", "exec", "custom_tool_call"),
        call("r1", 1, "exec_2", "exec", "custom_tool_call"),
      ],
      [itemRow("exec-ccc", 2, "commandExecution", { command: "pwd", status: "completed" })],
    );
    const [first, second] = view.calls.get("r1")!;
    expect(first!.nested).toMatchObject([
      { itemId: "exec-ccc", match: "ambiguous", candidates: 2 },
    ]);
    expect(second!.nested).toMatchObject([
      { itemId: "exec-ccc", match: "ambiguous", candidates: 2 },
    ]);
  });

  it("keeps items no call explains apart, and never joins across threads", () => {
    const view = runTools(
      [request("r1", 0, 1), request("r9", 0, 1, [], "th2")],
      [call("r9", 0, "call_x", "exec_command")],
      [
        itemRow("stray", 2, "commandExecution", { command: "whoami", status: "completed" }),
        // Same id as th2's call, but in th1: not its outcome.
        itemRow("call_x", 2, "commandExecution", { command: "id", status: "completed" }),
      ],
    );
    expect(view.calls.get("r9")![0]!.outcome).toBeNull();
    expect(view.unlinked.map((o) => o.itemId)).toEqual(["stray", "call_x"]);
  });

  it("takes what a call got back from its own thread, when two threads reuse a call id", () => {
    const view = runTools(
      [
        request("a1", 0, 1),
        request("a2", 5, 6, [["call_1", "from thread one"]]),
        request("b1", 10, 11, [], "th2"),
        request("b2", 15, 16, [["call_1", "from thread two"]], "th2"),
      ],
      [call("a1", 0, "call_1", "exec_command"), call("b1", 0, "call_1", "exec_command")],
      [],
    );
    expect(view.calls.get("a1")![0]!.returned?.text).toBe("from thread one");
    expect(view.calls.get("b1")![0]!.returned?.text).toBe("from thread two");
  });
});
