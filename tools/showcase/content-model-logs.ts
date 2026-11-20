// Model logs for a few of the story's runs, so Settings > Model logs and the run inspector have
// something real to show: Kit's DST fix in code mode (nested tool calls, a failed request and its
// retry, a large test log, a message too large to keep), Kit's migration that ran out of plan
// and went on with the API key (two turns, direct shell calls), and lighter runs for the list.
// Juno's first draft has no logs, for the empty state. Six weeks of older work fill the Usage and
// Tools tabs (`model-logs-history.ts`).
import { randomUUID } from "node:crypto";
import { modelRequests, runs } from "@open-bot/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { plus, type SeedContext } from "./lib";
import {
  functionCall,
  functionOutput,
  INSTRUCTIONS,
  KIT_HOME,
  LogSeeder,
  planLimits,
  reasoning,
  type RunRef,
  said,
  SANDBOX,
  span,
  TOOLS,
} from "./model-logs-lib";
import { kitBug } from "./model-logs-dst";
import { seedModelLogHistory } from "./model-logs-history";

const API_TOOLS = [
  {
    type: "function",
    name: "exec_command",
    description: "Run a shell command on the computer and return its output.",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" }, workdir: { type: "string" } },
      required: ["cmd"],
    },
  },
];

/** Kit's migration: the plan runs out, and the run goes on with the API key in a new thread. */
async function kitMigration(log: LogSeeder, run: RunRef, teammateId: string, prompt: string) {
  const at = span(run);
  const cwd = `${KIT_HOME}/kestrel`;
  const planThread = randomUUID();
  const planTurn = randomUUID();
  const context = [said("developer", SANDBOX), said("user", prompt)];
  await log.turn(run.id, planThread, planTurn, "plan", at(0));
  const planBase = { runId: run.id, threadId: planThread, turnId: planTurn };
  await log.event({
    ...planBase,
    at: plus(at(0), 30),
    method: "turn/started",
    payload: { threadId: planThread, turn: { id: planTurn } },
  });
  await log.request({
    teammateId,
    threadId: planThread,
    turnId: planTurn,
    kind: "turn",
    route: "plan",
    startedAt: plus(at(0), 200),
    firstByteMs: 310,
    endMs: 320,
    status: 429,
    input: context,
    output: [],
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached. Try again in 2 hours 32 minutes.",
    },
    rateLimits: planLimits(100, 71),
  });
  await log.event({
    ...planBase,
    at: plus(at(0), 560),
    method: "error",
    payload: {
      threadId: planThread,
      turnId: planTurn,
      error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
      willRetry: false,
    },
  });
  await log.event({
    ...planBase,
    at: plus(at(0), 600),
    method: "turn/completed",
    payload: { threadId: planThread, turn: { id: planTurn, status: "failed" } },
  });

  const keyThread = randomUUID();
  const keyTurn = randomUUID();
  const base = { runId: run.id, threadId: keyThread, turnId: keyTurn };
  const key = {
    teammateId,
    threadId: keyThread,
    turnId: keyTurn,
    kind: "turn" as const,
    route: "api" as const,
    instructions: INSTRUCTIONS,
    tools: API_TOOLS,
  };
  await log.turn(run.id, keyThread, keyTurn, "api_key", plus(at(0), 1200));
  await log.event({
    ...base,
    at: plus(at(0), 1250),
    method: "turn/started",
    payload: { threadId: keyThread, turn: { id: keyTurn } },
  });
  const call1 = functionCall("call_mg1", "exec_command", {
    cmd: "pnpm --filter migrate run dry-run --workspaces 40",
    workdir: cwd,
  });
  const r1 = await log.request({
    ...key,
    startedAt: plus(at(0), 1400),
    firstByteMs: 800,
    endMs: 2100,
    status: 200,
    input: context,
    output: [
      reasoning(
        "**Starting with a dry run**\nRun it against the staging copy for all 40 workspaces and read the summary.",
      ),
      call1,
    ],
    tokens: { input: 12_880, cached: 0, output: 356, reasoning: 120 },
  });
  const dryRun =
    'Migrating 40 workspaces (dry run)\n  ws_0007  events 1,204,331   ok   18.2s\n  ws_0019  events 3,911,002   ok   61.7s\n  ...\n\nSummary\n  ok        39\n  failed     1  (ws_0231: duplicate goal slug "signup")\n  duration  3m 20s';
  await log.item(
    base,
    {
      type: "commandExecution",
      id: "call_mg1",
      command: "pnpm --filter migrate run dry-run --workspaces 40",
      cwd,
      source: "agent",
      commandActions: [],
    },
    plus(r1.endedAt!, 100),
    200_000,
    { status: "completed", exitCode: 0, aggregatedOutput: dryRun },
  );
  const input2 = [...context, call1, functionOutput("call_mg1", dryRun)];
  const call2 = functionCall("call_mg2", "exec_command", {
    cmd: "pnpm --filter migrate run dry-run --workspaces ws_0231",
    workdir: cwd,
  });
  const r2 = await log.request({
    ...key,
    startedAt: at(0.8),
    firstByteMs: 700,
    endMs: 1800,
    status: 200,
    input: input2,
    output: [call2],
    tokens: { input: 13_910, cached: 12_800, output: 214 },
  });
  await log.item(
    base,
    {
      type: "commandExecution",
      id: "call_mg2",
      command: "pnpm --filter migrate run dry-run --workspaces ws_0231",
      cwd,
      source: "agent",
      commandActions: [],
    },
    plus(r2.endedAt!, 100),
    9_800,
    {
      status: "completed",
      exitCode: 0,
      aggregatedOutput:
        "  ws_0231  events 402,118   ok   9.4s\n\nSummary\n  ok         1\n  failed     0",
    },
  );
  await log.request({
    ...key,
    startedAt: at(0.95),
    firstByteMs: 900,
    endMs: 3100,
    status: 200,
    input: [...input2, call2, functionOutput("call_mg2", "  ws_0231  events 402,118   ok   9.4s")],
    output: [
      said("assistant", "39 of 40 workspaces migrated cleanly, and the one failure is fixed."),
    ],
    tokens: { input: 14_420, cached: 13_696, output: 702 },
  });
}

/** A short plan run: a prewarm and one answer, for the list. */
async function light(
  log: LogSeeder,
  run: RunRef,
  teammateId: string,
  prompt: string,
  answer: string,
  tokens: number,
) {
  const at = span(run);
  const threadId = randomUUID();
  const turnId = randomUUID();
  await log.turn(run.id, threadId, turnId, "plan", at(0));
  const input = [said("user", prompt)];
  await log.request({
    teammateId,
    threadId,
    turnId: null,
    kind: "prewarm",
    route: "plan",
    startedAt: plus(at(0), 60),
    firstByteMs: 160,
    endMs: 220,
    status: 200,
    input,
    output: [],
  });
  await log.request({
    teammateId,
    threadId,
    turnId,
    kind: "turn",
    route: "plan",
    startedAt: plus(at(0), 300),
    firstByteMs: 1200,
    endMs: 6400,
    status: 200,
    input,
    output: [said("assistant", answer)],
    tokens: { input: tokens, cached: Math.round(tokens * 0.7), output: 640 },
    rateLimits: planLimits(38, 17),
  });
  await log.event({
    runId: run.id,
    threadId,
    turnId,
    at: plus(at(0), 30),
    method: "turn/started",
    payload: { threadId, turn: { id: turnId } },
  });
}

export async function seedModelLogs(ctx: SeedContext) {
  const { R } = ctx;
  const team = ctx.teammates as Record<string, { id: string }>;
  const log = new LogSeeder(ctx.db);
  await kitBug(
    log,
    R.kitBug,
    team.kit!.id,
    "tidepool: recurring reminders that were set before the clocks changed fire an hour late afterwards. Reproduce it in the tests if you can, then fix it.",
  );
  await kitMigration(
    log,
    R.kitMigration,
    team.kit!.id,
    "Run the v1 to v2 migration against the staging copy for 40 workspaces and tell me what breaks. Don't touch production.",
  );
  await light(
    log,
    R.scoutPricing,
    team.scout!.id,
    "Quick landscape: what do Tallyfox, Pinwheel Analytics and Quillmetrics charge for their mid-tier plan?",
    "The three of them sit between $29 and $49 a month for their mid-tier plan.",
    22_400,
  );
  await light(
    log,
    R.miraTriage,
    team.mira!.id,
    "Triage my inbox.",
    "Three need you today; the rest can wait.",
    18_900,
  );
  await light(
    log,
    R.flights,
    team.iris!.id,
    "Find me flights to Lisbon for the summit.",
    "Two good options, both nonstop on TAP.",
    16_300,
  );
  await seedModelLogHistory(ctx, log);
}

/**
 * Who counted each run's usage. Runs with model logs are the current worker's: their requests
 * count toward usage (`counts_usage`), and they keep no legacy totals (the app would count both).
 * The others stand for runs the previous worker finished, counted by their legacy totals. The
 * latest API key request was cut off before the API reported its usage, so its tokens and cost
 * are an estimate.
 */
export async function seedUsageProducers(ctx: SeedContext) {
  const { orm } = ctx.db;
  await orm
    .update(modelRequests)
    .set({ countsUsage: true })
    .where(eq(modelRequests.source, "codex"));
  const [cut] = await orm
    .select({ id: modelRequests.id, warnings: modelRequests.parseWarnings })
    .from(modelRequests)
    .where(and(eq(modelRequests.route, "api"), sql`${modelRequests.inputTokens} > 0`))
    .orderBy(desc(modelRequests.startedAt))
    .limit(1);
  if (cut)
    await orm
      .update(modelRequests)
      .set({
        usageEstimated: true,
        reasoningTokens: null,
        stopReason: null,
        parseWarnings: [
          ...(cut.warnings ?? []),
          "the stream ended before the response did",
          "the API reported no usage, so its tokens and cost are an estimate that errs high",
        ],
      })
      .where(eq(modelRequests.id, cut.id));
  await orm
    .update(runs)
    .set({
      legacyPlanInputTokens: null,
      legacyPlanCachedInputTokens: null,
      legacyPlanOutputTokens: null,
      legacyPlanCostMicros: null,
      legacyApiKeyInputTokens: null,
      legacyApiKeyCachedInputTokens: null,
      legacyApiKeyOutputTokens: null,
      legacyApiKeyCostMicros: null,
      legacyUsageAt: null,
    })
    .where(
      sql`exists (select 1 from run_turns t join model_requests m
          on m.codex_thread_id = t.codex_thread_id and m.codex_turn_id = t.codex_turn_id
        where t.run_id = ${runs.id})
      or exists (select 1 from model_requests m
        where m.codex_thread_id = ${runs.codexThreadId} and m.codex_turn_id = ${runs.codexTurnId})`,
    );
}
