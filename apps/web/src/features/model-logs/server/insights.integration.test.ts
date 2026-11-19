// The Tools and Usage tabs and the JSONL export, through the API and the export route: tool
// stats and failures with their links to the model's calls, usage with every request attributed
// once, and an export that reads a run of any length a batch at a time.
import { randomUUID } from "node:crypto";
import { type ApiClient } from "@open-bot/api";
import { monthStart, toolItemFailed, toolNameOf } from "@open-bot/domain";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { execCall, functionCall, LogSeed, message } from "@/test/api/model-logs";

// The export is a route handler, which reads the session from the request's headers.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const now = Date.now();
// Runs start ten minutes into an hour, so a run's requests share an hour and a day.
const hour = Math.floor(now / 3_600_000) * 3_600_000;
const runAt = (days: number) => new Date(hour - days * 86_400_000 + 600_000);
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);
const planHeaders = (primary: number, secondary: number) => ({
  "x-codex-primary-used-percent": String(primary),
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-used-percent": String(secondary),
  "x-codex-secondary-window-minutes": "10080",
});
/** An export line, as far as these tests read it. */
type ExportedLine = {
  id: string;
  run_id: string | null;
  started_at: string;
  request: { input: { content: { text: string }[] }[] } | null;
  [field: string]: unknown;
};
const parseLine = (line: string) => JSON.parse(line) as ExportedLine;

const week = {
  from: new Date(now - 7 * 86_400_000).toISOString(),
  to: new Date(now).toISOString(),
};

describe.skipIf(!apiTestUrl)("model log tools, usage and export, through the API", () => {
  const harness = apiHarness();
  const { database } = harness;
  let api: ApiClient;
  let log: LogSeed;
  const t = { kit: "", mira: "" };
  const A = runAt(2);
  const B = runAt(3);
  const C = runAt(5);
  const ids = { a: "", b: "", c: "", old: "", large: "", r1: "", prewarm: "", memory: "" };
  /** Every completed item seeded in the week, as the domain would judge it. */
  const seeded: { type: string; item: Record<string, unknown>; omitted: boolean }[] = [];
  /** Requests on the API key, for this month's spend. */
  const keyed: { at: Date; costMicros: number }[] = [];

  beforeAll(async () => {
    api = harness.api;
    log = new LogSeed(database);
    t.kit = await log.teammate("Kit");
    t.mira = await log.teammate("Mira");
    const kitChat = await log.chat(t.kit, "Kit's bugs");
    const miraChat = await log.chat(t.mira, "Inbox");
    const item = async (
      run: { id: string; threadId: string; turnId: string },
      spec: {
        item: Record<string, unknown> & { id: string; type: string };
        at: Date;
        ms: number;
        completed: Record<string, unknown>;
        omitted?: boolean;
        expiredAt?: Date;
        inWeek?: boolean;
      },
    ) => {
      await log.item({ runId: run.id, threadId: run.threadId, turnId: run.turnId, ...spec });
      if (spec.inWeek !== false)
        seeded.push({
          type: spec.item.type,
          item: spec.omitted ? spec.item : { ...spec.item, ...spec.completed },
          omitted: spec.omitted ?? false,
        });
    };

    // Kit's run: a shell command the model called directly, then two code-mode cells at once.
    const a = await log.run({ teammateId: t.kit, chatId: kitChat, at: A });
    ids.a = a.id;
    ids.prewarm = await log.request({
      threadId: a.threadId,
      turnId: null,
      at: plus(A, 1500),
      kind: "prewarm",
      tokens: { input: 10, cached: 0, output: 1 },
    });
    ids.r1 = await log.request({
      ...a,
      at: plus(A, 2000),
      instructions: "You are Kit.",
      tools: [{ type: "function", name: "exec_command" }],
      input: [message("user", "Run the tests")],
      output: [functionCall("call_sh", "exec_command", { cmd: "pnpm test" })],
      tokens: { input: 1000, cached: 400, output: 100, reasoning: 20 },
      rateLimits: planHeaders(42, 7),
    });
    await log.request({
      ...a,
      at: plus(A, 10_000),
      output: [execCall("exec_1", "await tools.github()"), execCall("exec_2", "await other()")],
      tokens: { input: 2000, cached: 1600, output: 50 },
      rateLimits: planHeaders(55, 9),
    });
    await item(a, {
      item: { id: "call_sh", type: "commandExecution", command: "pnpm test" },
      at: plus(A, 3000),
      ms: 1000,
      completed: {
        status: "failed",
        exitCode: 1,
        durationMs: 1000,
        aggregatedOutput: "FAIL recurrence.test.ts",
      },
    });
    await item(a, {
      item: { id: "mcp_1", type: "mcpToolCall", server: "github", tool: "create_issue" },
      at: plus(A, 11_000),
      ms: 500,
      completed: {
        status: "failed",
        arguments: { title: "Flaky recurrence test" },
        error: { message: "rate limited" },
      },
    });
    for (const [n, ms] of [100, 200, 300].entries())
      await item(a, {
        item: { id: `call_ok${n}`, type: "commandExecution", command: "ls" },
        at: plus(A, 20_000 + n * 1000),
        ms,
        completed: { status: "completed", exitCode: 0, durationMs: ms },
      });
    await item(a, {
      item: { id: "call_big", type: "commandExecution", command: "cat huge.log" },
      at: plus(A, 30_000),
      ms: 400,
      completed: {},
      omitted: true,
    });
    // A request of Mira's whose run was deleted with its chat: still hers.
    await log.request({
      threadId: randomUUID(),
      turnId: randomUUID(),
      teammateId: t.mira,
      at: plus(A, 90_000),
      tokens: { input: 40, cached: 0, output: 4 },
    });
    // The memory AI's request, in no run.
    ids.memory = await log.request({
      threadId: null,
      turnId: null,
      at: plus(A, 100_000),
      source: "memory",
      model: "gpt-5.5-mini",
      tokens: { input: 5, cached: 0, output: 5 },
    });

    // Mira's run: one code-mode cell that ended, a failure inside it and a success after it.
    const b = await log.run({ teammateId: t.mira, chatId: miraChat, at: B });
    ids.b = b.id;
    await log.request({
      ...b,
      at: plus(B, 2000),
      output: [execCall("exec_9", "await tools.openbot.send_email()")],
      tokens: { input: 500, cached: 0, output: 30 },
      rateLimits: planHeaders(60, 12),
    });
    await log.request({
      ...b,
      at: plus(B, 30_000),
      route: "api",
      model: "gpt-5.5-mini",
      costMicros: 2500,
      input: [{ type: "custom_tool_call_output", call_id: "exec_9", output: "Script completed\n" }],
      tokens: { input: 300, cached: 100, output: 20 },
    });
    keyed.push({ at: plus(B, 30_000), costMicros: 2500 });
    await log.request({ ...b, at: plus(B, 50_000), status: 500, error: "server error" });
    await item(b, {
      item: { id: "dyn_1", type: "dynamicToolCall", namespace: "openbot", tool: "send_email" },
      at: plus(B, 5000),
      ms: 300,
      completed: {
        success: false,
        arguments: { to: "ana@example.test" },
        contentItems: [{ type: "inputText", text: "Recipient blocked" }],
      },
    });
    await item(b, {
      item: { id: "dyn_2", type: "dynamicToolCall", namespace: "openbot", tool: "send_email" },
      at: plus(B, 40_000),
      ms: 300,
      completed: { success: true },
    });

    // Mira's run whose bodies expired: the skeleton the sweep keeps, and the numbers.
    const c = await log.run({ teammateId: t.mira, chatId: miraChat, at: C });
    ids.c = c.id;
    await log.request({
      ...c,
      at: plus(C, 2000),
      tokens: { input: 700, cached: 0, output: 10 },
      expiredAt: new Date(now - 86_400_000),
    });
    await item(c, {
      item: { id: "call_exp", type: "commandExecution" },
      at: plus(C, 3000),
      ms: 50,
      completed: { status: "failed", exitCode: 2 },
      expiredAt: new Date(now - 86_400_000),
    });

    // An old failure and an old API key request, out of the week.
    const old = await log.run({ teammateId: t.kit, chatId: kitChat, at: runAt(20) });
    ids.old = old.id;
    await log.request({ ...old, at: plus(runAt(20), 2000), route: "api", costMicros: 99_999 });
    keyed.push({ at: plus(runAt(20), 2000), costMicros: 99_999 });
    await item(old, {
      item: { id: "call_old", type: "commandExecution", command: "make" },
      at: plus(runAt(20), 3000),
      ms: 10,
      completed: { status: "failed", exitCode: 2 },
      inWeek: false,
    });

    await database.db.execute(sql`update settings set monthly_cap_micros = 5000000`);
  });

  describe("the Tools tab", () => {
    it("counts calls, failures, unknown outcomes and durations per tool across teammates", async () => {
      const stats = await api.modelLogs.tools(week);
      expect(stats).toEqual([
        {
          name: "Shell command",
          type: "commandExecution",
          calls: 6,
          failed: 2,
          unknown: 1,
          medianMs: 250,
          p95Ms: 850,
          teammates: 2,
        },
        expect.objectContaining({ name: "openbot.send_email", calls: 2, failed: 1, teammates: 1 }),
        expect.objectContaining({ name: "github.create_issue", calls: 1, failed: 1, teammates: 1 }),
      ]);
      // Named and judged as `toolNameOf` and `toolItemFailed` do.
      const expected = new Map<string, { calls: number; failed: number }>();
      for (const s of seeded) {
        const name = toolNameOf(s.type, s.item);
        const entry = expected.get(name) ?? { calls: 0, failed: 0 };
        entry.calls += 1;
        if (!s.omitted && toolItemFailed(s.item)) entry.failed += 1;
        expected.set(name, entry);
      }
      expect(
        new Map(stats.map((stat) => [stat.name, { calls: stat.calls, failed: stat.failed }])),
      ).toEqual(expected);
      // A teammate, and a range with only the old failure.
      expect(
        (await api.modelLogs.tools({ ...week, teammateId: t.kit })).map((x) => x.calls),
      ).toEqual([5, 1]);
      expect(
        await api.modelLogs.tools({ to: new Date(now - 10 * 86_400_000).toISOString() }),
      ).toEqual([expect.objectContaining({ name: "Shell command", calls: 1, failed: 1 })]);
    });

    it("lists every failure with its input and output, and how surely it is tied to a call", async () => {
      const { failures, nextBefore } = await api.modelLogs.toolFailures(week);
      expect(nextBefore).toBeNull();
      expect(failures.map((f) => [f.itemId, f.name, f.link, f.candidates, f.runId])).toEqual([
        ["mcp_1", "github.create_issue", "ambiguous", 2, ids.a],
        ["call_sh", "Shell command", "exact", 1, ids.a],
        ["dyn_1", "openbot.send_email", "only_candidate", 1, ids.b],
        ["call_exp", "Shell command", "none", 0, ids.c],
      ]);
      const [mcp, shell, dynamic, expired] = failures;
      expect(shell).toMatchObject({
        input: { text: "pnpm test", chars: 9 },
        output: { text: "FAIL recurrence.test.ts" },
        status: "failed",
        exitCode: 1,
        durationMs: 1000,
        callName: "exec_command",
        callArguments: { text: '{"cmd":"pnpm test"}' },
        teammateName: "Kit",
        chatTitle: "Kit's bugs",
        bodiesExpiredAt: null,
      });
      expect(mcp!.input?.text).toContain("Flaky recurrence test");
      expect(mcp!.error).toContain("rate limited");
      expect(mcp!.callName).toBe("exec");
      expect(dynamic).toMatchObject({
        input: { text: expect.stringContaining("ana@example.test") },
        output: { text: "Recipient blocked" },
        callName: "exec",
        teammateName: "Mira",
      });
      // Expired: the status and exit code stay, what it was given and gave back are gone.
      expect(expired).toMatchObject({
        status: "failed",
        exitCode: 2,
        input: null,
        output: null,
        callName: null,
        bodiesExpiredAt: new Date(now - 86_400_000).toISOString(),
      });
    });

    it("narrows failures by tool and teammate, and pages them", async () => {
      const ids = async (input: Parameters<ApiClient["modelLogs"]["toolFailures"]>[0]) =>
        (await api.modelLogs.toolFailures(input)).failures.map((f) => f.itemId);
      expect(await ids({ ...week, tool: "Shell command" })).toEqual(["call_sh", "call_exp"]);
      expect(await ids({ ...week, teammateId: t.mira })).toEqual(["dyn_1", "call_exp"]);
      expect(await ids({})).toEqual(["mcp_1", "call_sh", "dyn_1", "call_exp", "call_old"]);
      const first = await api.modelLogs.toolFailures(week);
      const after = await api.modelLogs.toolFailures({
        ...week,
        before: `${first.failures[1]!.at.replace("Z", "000Z")}_${first.failures[1]!.eventId}`,
      });
      expect(after.failures.map((f) => f.itemId)).toEqual(["dyn_1", "call_exp"]);
      // Shaped like a cursor, at a time that doesn't exist: refused before it reaches Postgres.
      await expect(
        api.modelLogs.toolFailures({
          before: `2026-02-30T00:00:00.000000Z_${first.failures[1]!.eventId}`,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("the Usage tab", () => {
    it("adds up tokens, cost and errors over time, per teammate and per model", async () => {
      const usage = await api.modelLogs.usage(week);
      expect(usage.timeZone).toBe("Europe/Berlin");
      expect(usage.bucket).toBe("day");
      expect(usage.series.length).toBeGreaterThanOrEqual(8);
      expect(usage.totals).toEqual({
        requests: 9,
        inputTokens: 4555,
        cachedInputTokens: 2100,
        outputTokens: 220,
        reasoningTokens: 20,
        costMicros: 2500,
        errors: 1,
      });
      // The series adds up to the totals, and Kit's day holds everything sent around Kit's run.
      const summed = usage.series.reduce((sum, day) => sum + day.inputTokens, 0);
      expect(summed).toBe(usage.totals.inputTokens);
      const kitDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(A);
      expect(usage.series.find((day) => day.bucket === kitDay)?.inputTokens).toBe(3055);
      // The prewarm, which names no turn, counts once, for Kit; the orphaned request, for Mira.
      expect(usage.teammates.map((x) => [x.name, x.requests, x.inputTokens, x.errors])).toEqual([
        ["Kit", 3, 3010, 0],
        ["Mira", 5, 1540, 1],
        [null, 1, 5, 0],
      ]);
      expect(usage.models.map((x) => [x.model, x.requests])).toEqual([
        ["gpt-5.5", 7],
        ["gpt-5.5-mini", 2],
      ]);
    });

    it("draws the plan's windows from the rate-limit headers, and this month's key spend", async () => {
      const usage = await api.modelLogs.usage(week);
      expect(usage.planWindows.primaryMinutes).toBe(300);
      expect(usage.planWindows.secondaryMinutes).toBe(10080);
      // Over a week, each day's peak, from midnight in the owner's zone.
      const berlin = (at: string, time: boolean) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Berlin",
          ...(time ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
        }).format(new Date(at));
      expect(usage.planWindows.step).toBe("day");
      expect(
        usage.planWindows.points.map((p) => [berlin(p.at, false), berlin(p.at, true), p.primary]),
      ).toEqual([
        [berlin(new Date(hour - 3 * 86_400_000).toISOString(), false), "00:00", 60],
        [berlin(new Date(hour - 2 * 86_400_000).toISOString(), false), "00:00", 55],
      ]);
      expect(usage.planWindows.points.map((p) => p.secondary)).toEqual([12, 9]);
      // Over a few days, each hour's highest reading.
      const days = await api.modelLogs.usage({
        from: new Date(now - 2.5 * 86_400_000).toISOString(),
        to: new Date(now).toISOString(),
      });
      expect(days.planWindows.step).toBe("hour");
      expect(days.planWindows.points).toEqual([
        { at: new Date(hour - 2 * 86_400_000).toISOString(), primary: 55, secondary: 9 },
      ]);
      const month = monthStart();
      expect(usage.apiKey).toEqual({
        monthStart: month.toISOString(),
        spendMicros: keyed
          .filter((request) => request.at >= month)
          .reduce((sum, request) => sum + request.costMicros, 0),
        capMicros: 5_000_000,
      });
      await expect(api.modelLogs.usage({ from: week.to, to: week.from })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      const decade = new Date(now - 3650 * 86_400_000).toISOString();
      await expect(api.modelLogs.usage({ from: decade, to: week.to })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  describe("the JSONL export", () => {
    const lines = async (response: Response) =>
      (await response.text()).split("\n").filter(Boolean).map(parseLine);

    it("rebuilds each of a run's requests in full, oldest first, as a download", async () => {
      const { GET } = await import("@/app/api/model-logs/export/route");
      const response = await GET(
        new Request(`http://localhost/api/model-logs/export?runId=${ids.a}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="model-logs-run-${ids.a.slice(0, 8)}.jsonl"`,
      );
      const requests = await lines(response);
      expect(requests.map((x) => x.id)).toEqual([ids.prewarm, ids.r1, expect.any(String)]);
      expect(requests.every((x) => x.run_id === ids.a)).toBe(true);
      expect(requests[1]).toMatchObject({
        request: {
          model: "gpt-5.5",
          stream: true,
          instructions: "You are Kit.",
          tools: [{ type: "function", name: "exec_command" }],
          input: [message("user", "Run the tests")],
        },
        response: { output: [functionCall("call_sh", "exec_command", { cmd: "pnpm test" })] },
        tool_calls: [
          { call_id: "call_sh", name: "exec_command", arguments: '{"cmd":"pnpm test"}' },
        ],
        usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 },
        rate_limit_headers: planHeaders(42, 7),
      });
    });

    it("exports a date range with each request's run, and expired requests without bodies", async () => {
      const { GET } = await import("@/app/api/model-logs/export/route");
      const range = new URLSearchParams({
        from: plus(A, -60_000).toISOString(),
        to: plus(A, 200_000).toISOString(),
      });
      const requests = await lines(
        await GET(new Request(`http://localhost/api/model-logs/export?${range}`)),
      );
      expect(requests.map((x) => [x.id, x.run_id])).toEqual([
        [ids.prewarm, ids.a],
        [ids.r1, ids.a],
        [expect.any(String), ids.a],
        [expect.any(String), null],
        [ids.memory, null],
      ]);
      const [expired] = await lines(
        await GET(new Request(`http://localhost/api/model-logs/export?runId=${ids.c}`)),
      );
      expect(expired).toMatchObject({
        request: null,
        response: null,
        usage: { input_tokens: 700 },
        params: { model: "gpt-5.5" },
        bodies_expired_at: new Date(now - 86_400_000).toISOString(),
      });
      for (const query of [`runId=${ids.a}&from=${A.toISOString()}`, "runId=nope", "page=2"])
        expect(
          (await GET(new Request(`http://localhost/api/model-logs/export?${query}`))).status,
        ).toBe(400);
    });

    it("exports each request in the shape it was sent, and an expired one without its text", async () => {
      const at = new Date(now - 200 * 86_400_000);
      const scalar = await log.request({
        threadId: null,
        turnId: null,
        at,
        params: { model: "gpt-5", input: "private retention example" },
      });
      const messages = [message("user", "I moved to Lisbon."), message("assistant", "Noted.")];
      const extraction = await log.request({
        threadId: null,
        turnId: null,
        at: plus(at, 1000),
        source: "memory",
        kind: "extraction",
        endpoint: "https://api.openai.com/v1/chat/completions",
        params: { model: "gpt-5-mini", response_format: { type: "json_object" } },
        input: messages,
      });
      const embedding = await log.request({
        threadId: null,
        turnId: null,
        at: plus(at, 2000),
        source: "memory",
        kind: "embedding",
        endpoint: "https://api.openai.com/v1/embeddings",
        params: { model: "text-embedding-3-small" },
        input: ["I moved to Lisbon."],
      });
      // Expired before its parameters were cut down, as a sweep from before this change left it.
      const expired = await log.request({
        threadId: null,
        turnId: null,
        at: plus(at, 3000),
        params: { model: "gpt-5", input: "private expired text", reasoning: { effort: "low" } },
        expiredAt: new Date(now - 86_400_000),
      });
      const { GET } = await import("@/app/api/model-logs/export/route");
      const range = new URLSearchParams({
        from: plus(at, -1000).toISOString(),
        to: plus(at, 10_000).toISOString(),
      });
      const response = await GET(new Request(`http://localhost/api/model-logs/export?${range}`));
      const text = await response.text();
      const byId = new Map(
        text
          .split("\n")
          .filter(Boolean)
          .map(parseLine)
          .map((line) => [line.id, line]),
      );
      expect(byId.get(scalar)!.request).toEqual({
        model: "gpt-5",
        input: "private retention example",
      });
      expect(byId.get(extraction)!.request).toEqual({
        model: "gpt-5-mini",
        response_format: { type: "json_object" },
        messages,
      });
      expect(byId.get(embedding)!.request).toEqual({
        model: "text-embedding-3-small",
        input: "I moved to Lisbon.",
      });
      expect(byId.get(expired)).toMatchObject({
        request: null,
        response: null,
        params: { model: "gpt-5", reasoning: { effort: "low" } },
        bodies_expired_at: new Date(now - 86_400_000).toISOString(),
      });
      expect(text).not.toContain("private expired text");

      // The inspector rebuilds the same body, and shows an expired request the same way.
      const opened = await api.modelLogs.request({ requestId: scalar });
      expect(JSON.parse(opened.body!)).toEqual(byId.get(scalar)!.request);
      expect(JSON.parse((await api.modelLogs.request({ requestId: extraction })).body!)).toEqual(
        byId.get(extraction)!.request,
      );
      const gone = await api.modelLogs.request({ requestId: expired });
      expect(gone.body).toBeNull();
      expect(JSON.parse(gone.params!)).toEqual(byId.get(expired)!.params);
    });

    it("streams a run of any length a batch at a time, past the inspector's cap", async () => {
      const { exportStream, EXPORT_BATCH } = await import("./export");
      const { MODEL_LOG_RUN_REQUESTS } = await import("@open-bot/api");
      const total = MODEL_LOG_RUN_REQUESTS + 20;
      const kitChat = await log.chat(t.kit, "Long run");
      const run = await log.run({ teammateId: t.kit, chatId: kitChat, at: runAt(1) });
      const hash = await log.blob(message("user", "x".repeat(2000)));
      await database.db.execute(sql`
        insert into model_requests (id, source, route, transport, method, endpoint,
          codex_thread_id, codex_turn_id, request_kind, model, status, started_at,
          request_headers, params, cost_micros)
        select gen_random_uuid(), 'codex', 'plan', 'http', 'POST', '/responses',
          ${run.threadId}, ${run.turnId}, 'turn', 'gpt-5.5', 200,
          ${plus(runAt(1), 2000).toISOString()}::timestamptz + g * interval '1 millisecond',
          '{}'::jsonb, '{"model":"gpt-5.5"}'::jsonb, 0
        from generate_series(1, ${total}) g`);
      await database.db.execute(sql`
        insert into model_request_items (request_id, side, position, blob_hash)
        select id, 'input', 0, ${hash} from model_requests where codex_thread_id = ${run.threadId}`);

      const batches: number[] = [];
      const reader = exportStream({ runId: run.id }, (n) => batches.push(n)).getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      // One line read, one batch fetched: nothing ahead of the reader.
      expect(batches).toEqual([EXPORT_BATCH]);
      const decoder = new TextDecoder();
      let text = decoder.decode(first.value, { stream: true });
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        text += decoder.decode(chunk.value, { stream: true });
      const exported = text.split("\n").filter(Boolean).map(parseLine);
      expect(exported).toHaveLength(total);
      expect(new Set(exported.map((x) => x.id)).size).toBe(total);
      expect(exported.map((x) => x.started_at)).toEqual(
        exported.map((x) => x.started_at).toSorted(),
      );
      expect(exported.at(-1)!.request!.input[0]!.content[0]!.text).toHaveLength(2000);
      expect(batches).toHaveLength(Math.ceil(total / EXPORT_BATCH));
      expect(batches.slice(0, -1).every((n) => n === EXPORT_BATCH)).toBe(true);
    });
  });
});
