import type { WireMessage } from "@open-bot/agent";
import { type AuthMode, MAX_EVENT_SIZE } from "@open-bot/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@open-bot/db";
import { CodexEventTap } from "./codex-events";
import { type CodexEventRow, ModelLogWriter, type RunTurnRow } from "./writer";

// A ChatGPT access token's shape: a JWT.
const ACCESS_TOKEN =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE5MzQ0ZTY1In0.eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdfQ.c2lnbmF0dXJl";

/** A payload's size as the client measures it, near enough: its JSON text's length. */
const sizeOf = (payload: unknown) => JSON.stringify(payload)?.length ?? 0;
/** A notification whose size is given, for payloads that can't be serialized here. */
const sized = (method: string, params: unknown, size: number): WireMessage => ({
  direction: "from_codex",
  kind: "notification",
  id: null,
  method,
  payload: params,
  size,
});

/** The live runs, as the session registry would answer. */
class Runs {
  readonly live = new Map<string, { thread: string | null; mode: AuthMode }>();
  runForThread(threadId: string) {
    for (const [runId, run] of this.live)
      if (run.thread === threadId) return { runId, accessMode: run.mode };
    return null;
  }
  accessMode(runId: string) {
    return this.live.get(runId)?.mode ?? null;
  }
}

const request = (
  direction: WireMessage["direction"],
  id: number,
  method: string,
  payload: unknown,
): WireMessage => ({ direction, kind: "request", id, method, payload, size: sizeOf(payload) });
const response = (
  direction: WireMessage["direction"],
  id: number,
  method: string,
  result: unknown,
): WireMessage => ({
  direction,
  kind: "response",
  id,
  method,
  payload: { result },
  size: sizeOf({ result }),
});
const notification = (method: string, params: unknown): WireMessage => ({
  direction: "from_codex",
  kind: "notification",
  id: null,
  method,
  payload: params,
  size: sizeOf(params),
});

describe("CodexEventTap", () => {
  let events: CodexEventRow[];
  let turns: RunTurnRow[];
  let lost: string[];
  let runs: Runs;
  let scope: string | undefined;
  let tap: CodexEventTap;

  beforeEach(() => {
    events = [];
    turns = [];
    lost = [];
    runs = new Runs();
    scope = undefined;
    tap = newTap((work) => work());
  });

  /** A tap that hands its deferred redactions to `defer`. */
  function newTap(defer: (work: () => void) => void) {
    return new CodexEventTap({
      writer: {
        addEvent: (row) => events.push(row) > 0,
        addTurn: (row) => turns.push(row),
        lostEvent: (_at, reason) => lost.push(reason),
        reserveEvent: () => null,
        releaseEvent: () => {},
      },
      runs,
      currentRunId: () => scope,
      defer,
    });
  }

  /** A run's turn as Codex 0.162.1 sends it, from thread/start to turn/completed. */
  function runTurn(
    observe: (message: WireMessage) => void,
    run: string,
    thread: string,
    turn: string,
    ids: { start: number; turn: number },
  ) {
    scope = run;
    runs.live.set(run, { thread: null, mode: runs.live.get(run)?.mode ?? "plan" });
    observe(
      request("to_codex", ids.start, "thread/start", {
        model: "gpt-6.1-sol",
        cwd: "/home/bot/work/iris",
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      }),
    );
    // Codex answers, then announces the thread (thread_processor.rs in 0.162.1), before the
    // session has saved the thread's id.
    observe(response("from_codex", ids.start, "thread/start", { thread: { id: thread } }));
    observe(notification("thread/started", { thread: { id: thread, preview: "" } }));
    runs.live.get(run)!.thread = thread;
    observe(
      request("to_codex", ids.turn, "turn/start", {
        threadId: thread,
        input: [{ type: "text", text: "List the files.", text_elements: [] }],
      }),
    );
    observe(notification("turn/started", { threadId: thread, turn: { id: turn } }));
    observe(
      response("from_codex", ids.turn, "turn/start", {
        turn: { id: turn, items: [], status: "inProgress", error: null },
      }),
    );
    scope = undefined;
  }

  it("gives every message of a run's turn its run, thread and turn", () => {
    const observe = tap.connection();
    runTurn(observe, "run-1", "thr-1", "turn-1", { start: 4, turn: 5 });
    observe(
      notification("item/started", {
        threadId: "thr-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "exec-1", command: "ls", status: "inProgress" },
      }),
    );
    // A dynamic tool call: Codex asks the worker, and the worker answers out of the run's scope.
    observe(
      request("from_codex", 0, "item/tool/call", {
        threadId: "thr-1",
        turnId: "turn-1",
        callId: "call_ef71237",
        namespace: null,
        tool: "send_message",
        arguments: { text: "hi" },
      }),
    );
    observe(
      response("to_codex", 0, "item/tool/call", {
        success: true,
        contentItems: [{ type: "inputText", text: "Sent." }],
      }),
    );
    observe(notification("turn/completed", { threadId: "thr-1", turn: { id: "turn-1" } }));
    // Codex accounts the turn after the run ended: it is still the run's, by its turn.
    runs.live.delete("run-1");
    observe(notification("thread/tokenUsage/updated", { threadId: "thr-1", turnId: "turn-1" }));
    // A message on no run's turn or thread belongs to no run.
    observe(notification("account/rateLimits/updated", { rateLimits: {} }));

    expect(
      events.map((event) => [
        event.direction,
        event.kind,
        event.method,
        event.runId,
        event.codexThreadId,
        event.codexTurnId,
        event.itemId,
      ]),
    ).toEqual([
      ["to_codex", "request", "thread/start", "run-1", null, null, null],
      ["from_codex", "response", "thread/start", "run-1", "thr-1", null, null],
      ["from_codex", "notification", "thread/started", "run-1", "thr-1", null, null],
      ["to_codex", "request", "turn/start", "run-1", "thr-1", null, null],
      ["from_codex", "notification", "turn/started", "run-1", "thr-1", "turn-1", null],
      ["from_codex", "response", "turn/start", "run-1", "thr-1", "turn-1", null],
      ["from_codex", "notification", "item/started", "run-1", "thr-1", "turn-1", "exec-1"],
      ["from_codex", "request", "item/tool/call", "run-1", "thr-1", "turn-1", "call_ef71237"],
      ["to_codex", "response", "item/tool/call", "run-1", "thr-1", "turn-1", "call_ef71237"],
      ["from_codex", "notification", "turn/completed", "run-1", "thr-1", "turn-1", null],
      ["from_codex", "notification", "thread/tokenUsage/updated", "run-1", "thr-1", "turn-1", null],
      ["from_codex", "notification", "account/rateLimits/updated", null, null, null, null],
    ]);
    expect(events.map((event) => event.rpcId)).toEqual([
      "4",
      "4",
      null,
      "5",
      null,
      "5",
      null,
      "0",
      "0",
      null,
      null,
      null,
    ]);
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(events[8]!.payload).toEqual({
      result: { success: true, contentItems: [{ type: "inputText", text: "Sent." }] },
    });
  });

  it("records each turn/start that returns, two for a run that fell back to the API key", () => {
    const observe = tap.connection();
    runTurn(observe, "run-1", "thr-plan", "turn-plan", { start: 1, turn: 2 });
    // The plan ran out: the same run goes on with the API key, in a new thread.
    runs.live.get("run-1")!.mode = "api_key";
    runTurn(observe, "run-1", "thr-key", "turn-key", { start: 3, turn: 4 });
    expect(turns.map(({ startedAt: _startedAt, ...turn }) => turn)).toEqual([
      { runId: "run-1", codexThreadId: "thr-plan", codexTurnId: "turn-plan", accessMode: "plan" },
      {
        runId: "run-1",
        codexThreadId: "thr-key",
        codexTurnId: "turn-key",
        accessMode: "api_key",
      },
    ]);
    // The plan thread's late messages stay with the run, by their turn.
    observe(notification("turn/completed", { threadId: "thr-plan", turn: { id: "turn-plan" } }));
    expect(events.at(-1)).toMatchObject({ runId: "run-1", codexTurnId: "turn-plan" });
  });

  it("records no turn when turn/start fails", () => {
    const observe = tap.connection();
    scope = "run-1";
    runs.live.set("run-1", { thread: "thr-1", mode: "plan" });
    observe(request("to_codex", 1, "turn/start", { threadId: "thr-1", input: [] }));
    observe({
      direction: "from_codex",
      kind: "response",
      id: 1,
      method: "turn/start",
      payload: { error: { code: -32600, message: "thread not found" } },
      size: 70,
    });
    expect(turns).toEqual([]);
    expect(events.at(-1)).toMatchObject({ runId: "run-1", kind: "response" });
  });

  it("skips streaming deltas and counts them on the completed item, or the turn", () => {
    const observe = tap.connection();
    runTurn(observe, "run-1", "thr-1", "turn-1", { start: 1, turn: 2 });
    const at = { threadId: "thr-1", turnId: "turn-1" };
    for (const delta of ["Hel", "lo"])
      observe(notification("item/agentMessage/delta", { ...at, itemId: "msg_1", delta }));
    observe(notification("item/reasoning/summaryTextDelta", { ...at, itemId: "rs_1", delta: "x" }));
    observe(
      notification("item/commandExecution/outputDelta", { ...at, itemId: "exec-1", delta: "a" }),
    );
    observe(
      notification("item/completed", {
        ...at,
        item: { type: "agentMessage", id: "msg_1", text: "Hello", phase: null },
      }),
    );
    observe(notification("turn/completed", { threadId: "thr-1", turn: { id: "turn-1" } }));

    expect(events.some((event) => /delta$/i.test(event.method))).toBe(false);
    const completed = events.find((event) => event.method === "item/completed");
    expect(completed?.deltaCounts).toEqual({ msg_1: { "item/agentMessage/delta": 2 } });
    const turn = events.find((event) => event.method === "turn/completed");
    // Items that never completed are counted on their turn.
    expect(turn?.deltaCounts).toEqual({
      rs_1: { "item/reasoning/summaryTextDelta": 1 },
      "exec-1": { "item/commandExecution/outputDelta": 1 },
    });
  });

  it("redacts the sign-in and the token refresh before queueing them", () => {
    const observe = tap.connection();
    observe(
      request("to_codex", 1, "account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: ACCESS_TOKEN,
        chatgptAccountId: "acct-1",
      }),
    );
    observe(
      request("from_codex", 9, "account/chatgptAuthTokens/refresh", { reason: "unauthorized" }),
    );
    observe(
      response("to_codex", 9, "account/chatgptAuthTokens/refresh", {
        accessToken: ACCESS_TOKEN,
        chatgptAccountId: "acct-1",
        chatgptPlanType: null,
      }),
    );
    const stored = JSON.stringify(events.map((event) => event.payload));
    expect(stored).not.toContain(ACCESS_TOKEN.slice(0, 20));
    expect(stored).not.toContain("acct-1");
    expect(events.map((event) => event.runId)).toEqual([null, null, null]);
  });

  it("redacts after the connection has handled the message, keeping wire order", () => {
    const later: (() => void)[] = [];
    const observe = newTap((work) => later.push(work)).connection();
    observe(notification("thread/started", { thread: { id: "thr-1" } }));
    observe(notification("item/completed", { threadId: "thr-1", item: { id: "a", type: "plan" } }));
    // Nothing was redacted or queued while the connection was handling the messages.
    expect(events).toEqual([]);
    for (const work of later) work();
    expect(events.map((event) => event.method)).toEqual(["thread/started", "item/completed"]);
    expect(events[0]!.sequence).toBeLessThan(events[1]!.sequence);
  });

  it("holds room in the writer's queue for each message waiting for redaction", () => {
    // A real writer with a 64 KiB queue; nothing here reaches its database.
    const writer = new ModelLogWriter(
      {} as Db,
      { warn() {}, error() {} },
      { maxQueueBytes: 64 * 1024, flushMs: 3_600_000, backoffMs: 3_600_000 },
    );
    let dropped = 0;
    writer.on("dropped", (count) => (dropped += count));
    const later: (() => void)[] = [];
    const observe = new CodexEventTap({
      writer,
      runs,
      currentRunId: () => undefined,
      defer: (work) => later.push(work),
    }).connection();
    const text = "x".repeat(10 * 1024);
    for (let index = 0; index < 100; index += 1)
      observe(
        notification("item/completed", {
          threadId: "thr-1",
          item: { id: `msg_${index}`, type: "agentMessage", text },
        }),
      );
    // Only what fits the queue waits with its payload; the rest are counted as lost at once.
    expect(later.length).toBeGreaterThan(0);
    expect(later.length * (512 + text.length)).toBeLessThanOrEqual(64 * 1024);
    expect(later.length + dropped).toBe(100);
    expect(writer.pending).toBe(0);
    // Each waiting message has its room when its redaction runs.
    for (const work of later) work();
    expect(writer.pending).toBe(later.length);
    expect(later.length + dropped).toBe(100);
  });

  it("finishes the messages waiting for redaction when drained at shutdown", async () => {
    // Redaction deferred with `setImmediate`, as in the worker.
    const drained = new CodexEventTap({
      writer: {
        addEvent: (row) => events.push(row) > 0,
        addTurn: (row) => turns.push(row),
        lostEvent: (_at, reason) => lost.push(reason),
        reserveEvent: () => null,
        releaseEvent: () => {},
      },
      runs,
      currentRunId: () => undefined,
    });
    const observe = drained.connection();
    observe(notification("item/completed", { threadId: "thr-1", item: { id: "a", type: "plan" } }));
    expect(events).toEqual([]);
    expect(drained.pending).toBe(1);
    drained.drain();
    expect(events.map((event) => event.itemId)).toEqual(["a"]);
    expect(drained.pending).toBe(0);
    // The deferred run comes later and does nothing; a message after the drain is queued at once.
    await new Promise((resolve) => setImmediate(resolve));
    observe(notification("item/completed", { threadId: "thr-1", item: { id: "b", type: "plan" } }));
    expect(events.map((event) => event.itemId)).toEqual(["a", "b"]);
    expect(lost).toEqual([]);
  });

  it("stores only a stub for a message past MAX_EVENT_SIZE, without reading its payload", () => {
    const later: (() => void)[] = [];
    const observe = newTap((work) => later.push(work)).connection();
    // An MCP result of several megabytes; reading anything inside it would throw.
    const result = {
      threadId: "thr-1",
      item: { id: "call_mcp", type: "mcpToolCall" },
      get content(): never {
        throw new Error("the payload was read");
      },
    };
    observe(sized("item/completed", result, MAX_EVENT_SIZE + 1));
    expect(later).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        method: "item/completed",
        codexThreadId: "thr-1",
        itemId: "call_mcp",
        payload: { omitted: "it was too large to store", size: MAX_EVENT_SIZE + 1 },
      }),
    ]);
    expect(lost).toEqual(["a Codex message's payload wasn't stored: it was too large to store"]);
  });

  it("stores a stub and counts it lost when the payload can't be redacted", () => {
    const observe = tap.connection();
    let deep: unknown = "bottom";
    for (let index = 0; index < 12_000; index += 1) deep = { next: deep };
    observe(sized("item/completed", { threadId: "thr-1", item: { id: "x", deep } }, 120_000));
    expect(events).toEqual([
      expect.objectContaining({
        itemId: "x",
        payload: { omitted: "it nests too deep", size: 120_000 },
      }),
    ]);
    expect(lost).toEqual(["a Codex message's payload wasn't stored: it nests too deep"]);
  });

  it("counts a message it can't read as lost instead of throwing", () => {
    const observe = tap.connection();
    const unreadable = {
      get threadId(): never {
        throw new TypeError("unreadable");
      },
    };
    expect(() => observe(sized("item/completed", unreadable, 20))).not.toThrow();
    expect(events).toEqual([]);
    expect(lost).toEqual(["a Codex message couldn't be read (TypeError)"]);
  });

  it("keeps each connection's request ids apart", () => {
    const first = tap.connection();
    scope = "run-1";
    runs.live.set("run-1", { thread: "thr-1", mode: "plan" });
    first(request("to_codex", 1, "turn/start", { threadId: "thr-1", input: [] }));
    scope = undefined;
    // A reconnection numbers its requests from 1 again.
    const second = tap.connection();
    second(request("to_codex", 1, "account/read", {}));
    second(response("from_codex", 1, "account/read", { account: null }));
    expect(events.at(-1)).toMatchObject({ method: "account/read", runId: null });
  });
});
