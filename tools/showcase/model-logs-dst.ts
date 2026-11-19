// Kit's DST fix, as its model logs: code mode with nested shell, file and chat-title calls, a
// failed request and its retry, a large test log, and a message too large to keep.
import { randomUUID } from "node:crypto";
import { plus } from "./lib";
import {
  execCall,
  execOutput,
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

/** A long, realistic test log: the large body the inspector has to keep in its box. */
function verboseTestLog(): string {
  const lines: string[] = [` RUN  v3.2.4 ${KIT_HOME}/tidepool`, ""];
  const files = ["recurrence", "parse", "format", "storage"];
  for (const file of files)
    for (let i = 1; i <= 120; i++)
      lines.push(
        ` ✓ src/${file}.test.ts > ${file} > case ${String(i).padStart(3, "0")}: keeps the wall-clock time for rule ${i} across zones and daylight saving changes ${(i % 7) + 1}ms`,
      );
  lines.push("", " Test Files  4 passed (4)", "      Tests  85 passed (85)", "   Duration  2.41s");
  return lines.join("\n");
}

/** Kit's DST fix: code mode, nested calls, a failed request and its retry, and a large log. */
export async function kitBug(log: LogSeeder, run: RunRef, teammateId: string, prompt: string) {
  const at = span(run);
  const threadId = randomUUID();
  const turnId = randomUUID();
  const base = { runId: run.id, threadId, turnId };
  const cwd = `${KIT_HOME}/tidepool`;
  const plan = {
    teammateId,
    threadId,
    route: "plan" as const,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
  };
  await log.turn(run.id, threadId, turnId, "plan", at(0));
  await log.event({
    ...base,
    turnId: null,
    at: at(0),
    method: "turn/start",
    direction: "to_codex",
    kind: "request",
    rpcId: "41",
    payload: { threadId, input: [{ type: "text", text: prompt }] },
  });
  await log.event({
    ...base,
    at: plus(at(0), 40),
    method: "turn/start",
    kind: "response",
    rpcId: "41",
    payload: { result: { turn: { id: turnId, status: "inProgress" } } },
  });
  await log.event({
    ...base,
    at: plus(at(0), 45),
    method: "turn/started",
    payload: { threadId, turn: { id: turnId } },
  });

  const context = [
    said("developer", SANDBOX),
    said(
      "user",
      `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>bash</shell>\n  <current_date>2026-11-16</current_date>\n  <timezone>America/Los_Angeles</timezone>\n</environment_context>`,
    ),
    said("user", prompt),
  ];
  await log.request({
    ...plan,
    turnId: null,
    kind: "prewarm",
    startedAt: plus(at(0), 60),
    firstByteMs: 180,
    endMs: 240,
    status: 200,
    input: context,
    output: [],
    rateLimits: planLimits(41, 18),
  });

  // 1. Look around: two commands and the chat title, in one code cell.
  const think1 = reasoning(
    "**Looking at how the next fire time is computed**\nA reminder an hour late after DST usually means the interval is added in milliseconds, not calendar days in the rule's zone.",
  );
  const exec1 = execCall(
    "call_kXq1",
    `const status = await tools.exec_command({ cmd: "git status --short && git log --oneline -3", workdir: "${cwd}" });\ntext(status.output);\nconst hits = await tools.exec_command({ cmd: 'grep -rn "DAY_MS" src | head', workdir: "${cwd}" });\ntext(hits.output);\nawait tools.set_chat_title({ title: "Fix: reminders fire an hour late after DST" });`,
  );
  const r1 = await log.request({
    ...plan,
    turnId,
    kind: "turn",
    startedAt: plus(at(0), 300),
    firstByteMs: 900,
    endMs: 2600,
    status: 200,
    input: context,
    output: [think1, exec1],
    tokens: { input: 14_210, cached: 11_008, output: 412, reasoning: 128 },
    rateLimits: planLimits(41, 18),
  });
  const out1 =
    "Script completed\nWall time 0.6 seconds\nOutput:\nOn branch main\nabc1f3e Release 0.9.2\n7d09b21 Add weekly recurrence\n1e44c0a Fix monthly rollover\nsrc/recurrence.ts:6:const DAY_MS = 24 * 60 * 60 * 1000;\nsrc/recurrence.ts:21:  const next = new Date(rule.lastFiredAt.getTime() + rule.intervalDays * DAY_MS);";
  let t = plus(r1.firstByteAt!, 400);
  await log.item(
    base,
    {
      type: "commandExecution",
      id: `exec-${randomUUID()}`,
      command: "git status --short && git log --oneline -3",
      cwd,
      source: "agent",
      commandActions: [],
    },
    t,
    120,
    {
      status: "completed",
      exitCode: 0,
      aggregatedOutput:
        "On branch main\nabc1f3e Release 0.9.2\n7d09b21 Add weekly recurrence\n1e44c0a Fix monthly rollover",
    },
  );
  t = plus(t, 300);
  await log.item(
    base,
    {
      type: "commandExecution",
      id: `exec-${randomUUID()}`,
      command: 'grep -rn "DAY_MS" src | head',
      cwd,
      source: "agent",
      commandActions: [],
    },
    t,
    60,
    {
      status: "completed",
      exitCode: 0,
      aggregatedOutput:
        "src/recurrence.ts:6:const DAY_MS = 24 * 60 * 60 * 1000;\nsrc/recurrence.ts:21:  const next = new Date(rule.lastFiredAt.getTime() + rule.intervalDays * DAY_MS);",
    },
  );
  t = plus(t, 200);
  const titleId = `exec-${randomUUID()}`;
  await log.event({
    ...base,
    at: t,
    method: "item/tool/call",
    kind: "request",
    rpcId: "7",
    itemId: titleId,
    payload: {
      threadId,
      turnId,
      callId: titleId,
      tool: "set_chat_title",
      arguments: { title: "Fix: reminders fire an hour late after DST" },
    },
  });
  await log.event({
    ...base,
    at: plus(t, 30),
    method: "item/tool/call",
    direction: "to_codex",
    kind: "response",
    rpcId: "7",
    itemId: titleId,
    payload: {
      result: { contentItems: [{ type: "inputText", text: "Chat title set." }], success: true },
    },
  });
  await log.item(
    base,
    {
      type: "dynamicToolCall",
      id: titleId,
      namespace: null,
      tool: "set_chat_title",
      arguments: { title: "Fix: reminders fire an hour late after DST" },
    },
    t,
    40,
    {
      status: "completed",
      success: true,
      contentItems: [{ type: "inputText", text: "Chat title set." }],
    },
  );

  // 2. A failing test first, and a look at the log, which is too large to keep.
  const input2 = [...context, think1, exec1, execOutput("call_kXq1", out1)];
  const think2 = reasoning(
    "**Reproducing it in a test**\nI'll add a test across the March change, run it, and check the reminder log for the hour shift.",
  );
  const exec2 = execCall(
    "call_kXq2",
    `await tools.apply_patch({ patch: TEST_PATCH });\nconst run = await tools.exec_command({ cmd: "pnpm vitest run src/recurrence.test.ts", workdir: "${cwd}" });\ntext(run.output);\nconst logs = await tools.exec_command({ cmd: "cat logs/reminders.log", workdir: "${cwd}" });\ntext(logs.output.slice(-2000));`,
  );
  const r2 = await log.request({
    ...plan,
    turnId,
    kind: "turn",
    startedAt: at(0.22),
    firstByteMs: 1100,
    endMs: 3900,
    status: 200,
    input: input2,
    output: [think2, exec2],
    sentInputFrom: context.length + 2,
    tokens: { input: 15_870, cached: 14_080, output: 608, reasoning: 192 },
    rateLimits: planLimits(42, 18),
  });
  // Past the 2 seconds the first cell's window stays open after its result went back.
  t = plus(r2.firstByteAt!, 1500);
  await log.item(
    base,
    {
      type: "fileChange",
      id: `exec-${randomUUID()}`,
      changes: [
        {
          path: `${cwd}/src/recurrence.test.ts`,
          kind: { type: "update" },
          diff: '+  it("keeps the wall-clock time across a daylight saving change", () => {\n+    const rule = daily("09:00", "America/Los_Angeles", "2026-03-07T17:00:00Z");',
        },
      ],
    },
    t,
    80,
    { status: "completed" },
  );
  t = plus(t, 200);
  await log.item(
    base,
    {
      type: "commandExecution",
      id: `exec-${randomUUID()}`,
      command: "pnpm vitest run src/recurrence.test.ts",
      cwd,
      source: "agent",
      commandActions: [],
    },
    t,
    3100,
    {
      status: "failed",
      exitCode: 1,
      aggregatedOutput:
        " FAIL  src/recurrence.test.ts > nextOccurrence > keeps the wall-clock time across a daylight saving change\nAssertionError: expected '2026-03-08T17:00:00.000Z' to be '2026-03-08T16:00:00.000Z'\n\n Test Files  1 failed (1)\n      Tests  1 failed | 23 passed (24)",
    },
  );
  t = plus(t, 3300);
  await log.item(
    base,
    {
      type: "commandExecution",
      id: `exec-${randomUUID()}`,
      command: "cat logs/reminders.log",
      cwd,
      source: "agent",
      commandActions: [],
    },
    t,
    900,
    null,
  );

  // 3. The fix: the first request fails upstream, Codex sends it again.
  const out2 =
    "Script completed\nWall time 4.4 seconds\nOutput:\n FAIL  src/recurrence.test.ts > nextOccurrence > keeps the wall-clock time across a daylight saving change\nAssertionError: expected '2026-03-08T17:00:00.000Z' to be '2026-03-08T16:00:00.000Z'\n…\n2026-03-08T17:00:02Z fired reminder r_118 (rule daily 09:00 America/Los_Angeles)";
  const input3 = [...input2, think2, exec2, execOutput("call_kXq2", out2)];
  await log.request({
    ...plan,
    turnId,
    kind: "turn",
    startedAt: at(0.5),
    firstByteMs: 1400,
    endMs: 1500,
    status: 503,
    input: input3,
    output: [],
    sentInputFrom: input2.length + 2,
    error: {
      type: "server_error",
      message: "An error occurred while processing your request. You can retry your request.",
    },
    rateLimits: planLimits(43, 18),
  });
  const think3 = reasoning(
    "**Fixing it in calendar days**\nStep in calendar days in the rule's own zone, then re-apply the wall-clock time. Then the full suite, and the diff to report.",
  );
  const exec3 = execCall("call_kXq3", "await tools.apply_patch({ patch: FIX_PATCH });");
  const exec4 = execCall(
    "call_kXq4",
    `const all = await tools.exec_command({ cmd: "pnpm vitest run --reporter verbose", workdir: "${cwd}" });\ntext(all.output);\nconst stat = await tools.exec_command({ cmd: "git diff --stat", workdir: "${cwd}" });\ntext(stat.output);`,
  );
  const r4 = await log.request({
    ...plan,
    turnId,
    kind: "turn",
    startedAt: plus(at(0.5), 2600),
    firstByteMs: 1200,
    endMs: 4800,
    status: 200,
    input: input3,
    output: [think3, exec3, exec4],
    sentInputFrom: input2.length + 2,
    tokens: { input: 17_402, cached: 15_360, output: 1_284, reasoning: 512 },
    rateLimits: planLimits(44, 18),
  });
  const testLog = verboseTestLog();
  t = plus(r4.firstByteAt!, 900);
  await log.item(
    base,
    {
      type: "fileChange",
      id: `exec-${randomUUID()}`,
      changes: [
        {
          path: `${cwd}/src/recurrence.ts`,
          kind: { type: "update" },
          diff: "-  const next = new Date(rule.lastFiredAt.getTime() + rule.intervalDays * DAY_MS);\n+  const local = toZonedParts(rule.lastFiredAt, zone);",
        },
      ],
    },
    t,
    90,
    { status: "completed" },
  );
  t = plus(t, 300);
  await log.item(
    base,
    {
      type: "commandExecution",
      id: `exec-${randomUUID()}`,
      command: "pnpm vitest run --reporter verbose",
      cwd,
      source: "agent",
      commandActions: [],
    },
    t,
    4200,
    { status: "completed", exitCode: 0, aggregatedOutput: testLog },
  );
  t = plus(t, 4500);
  await log.item(
    base,
    {
      type: "commandExecution",
      id: `exec-${randomUUID()}`,
      command: "git diff --stat",
      cwd,
      source: "agent",
      commandActions: [],
    },
    t,
    50,
    {
      status: "completed",
      exitCode: 0,
      aggregatedOutput:
        " src/recurrence.test.ts | 14 ++++++++++++++\n src/recurrence.ts      | 12 ++++++++++--\n 2 files changed, 24 insertions(+), 2 deletions(-)",
    },
  );

  // 4. The answer.
  const input4 = [
    ...input3,
    think3,
    exec3,
    exec4,
    execOutput("call_kXq3", "Script completed\nWall time 0.1 seconds\nOutput:\n"),
    execOutput(
      "call_kXq4",
      `Script completed\nWall time 4.6 seconds\nOutput:\n${testLog}\n src/recurrence.test.ts | 14 ++++++++++++++\n src/recurrence.ts      | 12 ++++++++++--`,
    ),
  ];
  const answer = said(
    "assistant",
    "Fixed. Reminders kept their 9:00 after the March change in the new test, and the whole suite passes (85 tests). The fix steps in calendar days in the rule's own time zone instead of adding 24 hours per day.",
  );
  await log.request({
    ...plan,
    turnId,
    kind: "turn",
    startedAt: at(0.86),
    firstByteMs: 1000,
    endMs: 2900,
    status: 200,
    input: input4,
    output: [
      reasoning("**Writing it up**\nWhat changed, how I know it works, and the one edge case."),
      answer,
    ],
    sentInputFrom: input3.length + 3,
    tokens: { input: 31_904, cached: 17_152, output: 398, reasoning: 96 },
    rateLimits: planLimits(45, 19),
  });
  const done = plus(at(0.86), 3000);
  await log.event({
    ...base,
    at: done,
    method: "item/completed",
    itemId: "msg_final",
    payload: {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: "msg_final",
        text: answer.content[0]!.text,
        phase: "final",
      },
    },
    deltaCounts: { msg_final: { "item/agentMessage/delta": 46 } },
  });
  await log.event({
    ...base,
    at: plus(done, 20),
    method: "thread/tokenUsage/updated",
    payload: {
      threadId,
      turnId,
      tokenUsage: {
        total: { inputTokens: 79_386, cachedInputTokens: 57_600, outputTokens: 2_702 },
      },
    },
  });
  await log.event({
    ...base,
    at: plus(done, 40),
    method: "turn/completed",
    payload: { threadId, turn: { id: turnId, status: "completed" } },
    deltaCounts: { rs_1: { "item/reasoning/summaryTextDelta": 12 } },
  });
}
