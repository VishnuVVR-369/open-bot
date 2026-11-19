// Model logs where runs meet and grow long: a prewarm between two runs of one thread, a run
// whose requests repeat every earlier tool output, and runs created in the same microsecond
// across a page boundary.
import { createHash, randomUUID } from "node:crypto";
import { type ApiClient, MODEL_LOG_RUNS_PAGE } from "@open-bot/api";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { owned } from "@/test/api/seed";

const t0 = Date.now() - 3 * 60 * 60_000;
const at = (seconds: number) => new Date(t0 + seconds * 1000);
const json = (value: unknown) => JSON.stringify(value);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A node of a JSON query plan, as `explain (format json)` gives it. */
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/** Every node of a plan, its subplans and CTEs included. */
function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/** How many requests the long run makes, each carrying every earlier call and its output. */
const CUMULATIVE = 60;
/** Runs created in the same microsecond, one more than a page holds. */
const TIED = MODEL_LOG_RUNS_PAGE + 1;

describe.skipIf(!apiTestUrl)("model logs across runs and at scale", () => {
  const harness = apiHarness();
  const { ids, database } = harness;
  let api: ApiClient;
  const runA = randomUUID();
  const runB = randomUUID();
  const running = randomUUID();
  const cumulative = randomUUID();
  const tied = Array.from({ length: TIED }, () => randomUUID());
  const prewarm = { a: randomUUID(), b: randomUUID(), early: randomUUID(), late: randomUUID() };
  const cumulativeIds = Array.from({ length: CUMULATIVE }, () => randomUUID());

  beforeAll(async () => {
    api = harness.api;
    const s = await import("@open-bot/db");
    const db = database.db;
    const run = (id: string, created: number, completed: number | null) => ({
      id,
      chatId: ids.chat,
      ...owned(ids.teammate),
      trigger: "user" as const,
      prompt: "Go",
      status: completed === null ? ("running" as const) : ("completed" as const),
      createdAt: at(created),
      startedAt: at(created),
      completedAt: completed === null ? null : at(completed),
    });
    await db
      .insert(s.runs)
      .values([
        run(runA, 0, 2),
        run(runB, 5, 20),
        run(running, 300, null),
        run(cumulative, 100, 200),
        ...tied.map((id) => run(id, 2000, 2001)),
      ]);
    // Runs that start in the same microsecond, at full precision, newest of all.
    const tie = new Date(Date.now() + 60_000).toISOString().replace("Z", "456Z");
    await db.execute(
      sql`update runs set created_at = ${tie}::timestamptz where id in (${sql.join(
        tied.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    const turn = (runId: string, thread: string, turnId: string, seconds: number) => ({
      runId,
      codexThreadId: thread,
      codexTurnId: turnId,
      accessMode: "plan" as const,
      startedAt: at(seconds),
    });
    await db
      .insert(s.runTurns)
      .values([
        turn(runA, "shared", "tu-a", 0),
        turn(runB, "shared", "tu-b", 5),
        turn(running, "going", "tu-going", 300),
        turn(cumulative, "long", "tu-long", 100),
        ...tied.map((id, i) => turn(id, `tied-${i}`, `tu-tied-${i}`, 2000)),
      ]);

    const base = {
      source: "codex" as const,
      route: "plan" as const,
      transport: "websocket" as const,
      method: "response.create",
      endpoint: "/responses",
      model: "gpt-5.5",
      requestHeaders: {},
      teammateId: ids.teammate,
      status: 200,
    };
    // Two adjacent runs of one thread: A starts at 0 and ends at 2, B starts at 5.
    await db.insert(s.modelRequests).values([
      {
        ...base,
        id: prewarm.a,
        codexThreadId: "shared",
        codexTurnId: null,
        requestKind: "prewarm",
        startedAt: at(0.2),
        costMicros: 1,
      },
      {
        ...base,
        id: randomUUID(),
        codexThreadId: "shared",
        codexTurnId: "tu-a",
        requestKind: "turn",
        startedAt: at(0.5),
        costMicros: 10,
      },
      // Sent before B's turn/start returned, after A had ended: B's.
      {
        ...base,
        id: prewarm.early,
        codexThreadId: "shared",
        codexTurnId: null,
        requestKind: "prewarm",
        startedAt: at(4.9),
        costMicros: 100,
      },
      {
        ...base,
        id: prewarm.b,
        codexThreadId: "shared",
        codexTurnId: null,
        requestKind: "prewarm",
        startedAt: at(5.06),
        costMicros: 1_000,
      },
      {
        ...base,
        id: randomUUID(),
        codexThreadId: "shared",
        codexTurnId: "tu-b",
        requestKind: "turn",
        startedAt: at(5.5),
        costMicros: 10_000,
      },
      // A run still going: a prewarm long after its turn started is still its own.
      {
        ...base,
        id: prewarm.late,
        codexThreadId: "going",
        codexTurnId: null,
        requestKind: "prewarm",
        startedAt: at(900),
        costMicros: 5,
      },
    ]);

    // The long run: request k made call k and carried every earlier call and its output.
    const calls = cumulativeIds.map((_, k) =>
      json({ type: "function_call", name: "exec_command", call_id: `call_${k}`, arguments: "{}" }),
    );
    const outputs = cumulativeIds.map((_, k) =>
      json({ type: "function_call_output", call_id: `call_${k}`, output: `output ${k}` }),
    );
    const user = json({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Go" }],
    });
    await db.insert(s.modelBlobs).values(
      [user, ...calls, ...outputs].map((content) => ({
        hash: hash(content),
        kind: "item" as const,
        content,
        bytes: content.length,
      })),
    );
    await db.insert(s.modelRequests).values(
      cumulativeIds.map((id, k) => ({
        ...base,
        id,
        codexThreadId: "long",
        codexTurnId: "tu-long",
        requestKind: "turn",
        startedAt: at(100 + k),
      })),
    );
    const items = cumulativeIds.flatMap((requestId, k) => [
      { requestId, side: "input" as const, position: 0, blobHash: hash(user) },
      ...Array.from({ length: k }, (_, j) => [
        { requestId, side: "input" as const, position: 1 + 2 * j, blobHash: hash(calls[j]!) },
        { requestId, side: "input" as const, position: 2 + 2 * j, blobHash: hash(outputs[j]!) },
      ]).flat(),
    ]);
    for (let i = 0; i < items.length; i += 1_000)
      await db.insert(s.modelRequestItems).values(items.slice(i, i + 1_000));
    await db.insert(s.modelToolCalls).values(
      cumulativeIds.map((requestId, k) => ({
        requestId,
        position: 0,
        callId: `call_${k}`,
        type: "function_call",
        name: "exec_command",
        arguments: k === 0 ? "x".repeat(10_000) : "{}",
      })),
    );
  });

  /** Every page of the runs list, in order. */
  async function allRuns() {
    const runs = [];
    let before: string | undefined;
    do {
      const page = await api.modelLogs.runs({ before });
      runs.push(...page.runs);
      before = page.nextBefore ?? undefined;
    } while (before);
    return runs;
  }

  it("gives a prewarm to one run only, when two runs of a thread are close together", async () => {
    const [a, b] = await Promise.all([
      api.modelLogs.run({ runId: runA }),
      api.modelLogs.run({ runId: runB }),
    ]);
    const requestIds = (logs: typeof a) => logs.turns.flatMap((t) => t.requests.map((r) => r.id));
    expect(requestIds(a)).toContain(prewarm.a);
    expect(requestIds(b)).not.toContain(prewarm.a);
    expect(requestIds(b)).toEqual(expect.arrayContaining([prewarm.early, prewarm.b]));
    expect(requestIds(a)).not.toContain(prewarm.early);
    expect(a.totals).toMatchObject({ requests: 2, costMicros: 11 });
    expect(b.totals).toMatchObject({ requests: 3, costMicros: 11_100 });

    const listed = await allRuns();
    expect(listed.find((r) => r.runId === runA)).toMatchObject({ requests: 2, costMicros: 11 });
    expect(listed.find((r) => r.runId === runB)).toMatchObject({ requests: 3, costMicros: 11_100 });
    expect(listed.find((r) => r.runId === running)).toMatchObject({ requests: 1, costMicros: 5 });
    const going = await api.modelLogs.run({ runId: running });
    expect(going.turns[0]!.requests.map((r) => [r.id, r.turnMatch])).toEqual([
      [prewarm.late, "time"],
    ]);
  });

  it("reads each tool output once, however many later requests repeat it", async () => {
    const { firstToolOutputs } = await import("./tools");
    const rows = await firstToolOutputs(cumulativeIds);
    // One per call that got something back, not one per request that carried it.
    expect(rows).toHaveLength(CUMULATIVE - 1);
    expect(new Set(rows.map((row) => row.call_id)).size).toBe(CUMULATIVE - 1);
    for (const row of rows) {
      const k = Number(row.call_id.slice("call_".length));
      expect(row.request_id).toBe(cumulativeIds[k + 1]);
    }

    const logs = await api.modelLogs.run({ runId: cumulative });
    const calls = logs.turns.flatMap((t) => t.requests.flatMap((r) => r.toolCalls));
    expect(calls).toHaveLength(CUMULATIVE);
    expect(calls.slice(0, -1).map((c) => c.returned?.text)).toEqual(
      Array.from({ length: CUMULATIVE - 1 }, (_, k) => `output ${k}`),
    );
    expect(calls[0]!.arguments).toEqual({ text: "x".repeat(4_000), chars: 10_000 });
  });

  it("parses and cuts each tool output once, not once per request that repeats it", async () => {
    const { firstToolOutputsSql } = await import("./tools");
    const { rows } = await database.db.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      sql`explain (analyze, verbose, format json) ${firstToolOutputsSql(cumulativeIds)}`,
    );
    // Where a node computes the body's JSON or its preview, how many rows it did that for.
    const work = nodesOf(rows[0]!["QUERY PLAN"][0].Plan)
      .filter((node) =>
        ((node.Output as string[] | undefined) ?? []).some(
          (output) => output.includes("::jsonb") || output.includes("jsonb_path_query_first"),
        ),
      )
      .map((node) => (node["Actual Rows"] as number) * (node["Actual Loops"] as number));
    expect(work.length).toBeGreaterThan(0);
    // 59 outputs, each repeated by every later request: 1,770 times in all.
    expect(Math.max(...work)).toBe(CUMULATIVE - 1);
  });

  it("finds the turn a prewarm belongs to through the thread's turns in order, by index", async () => {
    const { unturnedTurnSql } = await import("./attribution");
    const plan = await database.db.transaction(async (tx) => {
      // The tables are tiny here; this asks which plan Postgres would use once they aren't.
      await tx.execute(sql`set local enable_seqscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        sql`explain (format json) select ${unturnedTurnSql("m")} as turn
          from model_requests m where m.id = ${prewarm.a}`,
      );
      return nodesOf(rows[0]!["QUERY PLAN"][0].Plan);
    });
    const turns = plan.filter((node) => node["Relation Name"] === "run_turns");
    // The latest turn before the request, read backwards, and the next one after it: both in the
    // index's order, so neither sorts the thread's turns.
    expect(turns.map((node) => [node["Index Name"], node["Scan Direction"]])).toEqual([
      ["run_turns_thread_started_idx", "Backward"],
      ["run_turns_thread_started_idx", "Forward"],
    ]);
    expect(plan.filter((node) => node["Node Type"] === "Sort")).toEqual([]);
  });

  it("pages through runs created in the same microsecond without skipping any", async () => {
    const first = await api.modelLogs.runs({});
    expect(first.runs).toHaveLength(MODEL_LOG_RUNS_PAGE);
    expect(first.nextBefore).not.toBeNull();
    const listed = (await allRuns()).map((r) => r.runId);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.slice(0, TIED).sort()).toEqual([...tied].sort());
    expect(listed).toEqual(expect.arrayContaining([runA, runB, cumulative]));
  });

  it("refuses a page of runs at a time that doesn't exist, as a bad request", async () => {
    for (const at of ["2026-99-99T00:00:00.000000Z", "2026-02-29T00:00:00.000000Z"])
      await expect(api.modelLogs.runs({ before: `${at}_${runA}` })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    await expect(
      api.modelLogs.runs({ before: `2024-02-29T00:00:00.000000Z_${runA}` }),
    ).resolves.toMatchObject({ runs: [] });
  });
});
