// Six weeks of older work, as model logs only: runs in each teammate's archived chat, so the
// Usage tab has weeks to draw (tokens, cache, cost and failed requests, and the plan's windows
// filling up each week, running out once and going on with the API key), the Tools tab has calls
// and failures of every kind (direct, in one code cell, and among two cells at once), and the
// runs list has teammates, chats, models and access modes to filter by. Runs past the 30 day
// retention window have had their bodies expired, the way the worker's sweep leaves them.
import { randomUUID } from "node:crypto";
import { chats, runs, settings } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { ago, plus, TIMEZONE, type SeedContext } from "./lib";
import {
  execCall,
  execOutput,
  functionCall,
  functionOutput,
  LogSeeder,
  planLimits,
  said,
} from "./model-logs-lib";

/** The retention the owner chose; older runs have had their bodies expired. */
export const RETENTION_DAYS = 30;
const WEEKS = 6;

/** The same story on every seed: a small fixed-seed generator. */
function seeded(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
}

type Who = {
  key: "kit" | "mira" | "scout" | "iris";
  chat: string;
  /** Weekdays it works on, Sunday 0. */
  days: number[];
  model: string;
  tokens: [number, number];
  prompts: string[];
};

const CAST: Who[] = [
  {
    key: "kit",
    chat: "tidepool maintenance",
    days: [1, 2, 3, 4, 5],
    model: "gpt-5.5",
    tokens: [38_000, 96_000],
    prompts: [
      "Bump the date library and run the suite.",
      "The nightly build is red again. Find out why.",
      "Add a test for reminders on Feb 29.",
      "Clean up the old recurrence helpers nobody calls.",
    ],
  },
  {
    key: "mira",
    chat: "Inbox, earlier",
    days: [0, 1, 2, 3, 4, 5, 6],
    model: "gpt-5.5-mini",
    tokens: [7_000, 19_000],
    prompts: ["Triage my inbox.", "Draft replies to anything from investors.", "Anything urgent?"],
  },
  {
    key: "scout",
    chat: "Market notes",
    days: [1, 3, 5],
    model: "gpt-5.5",
    tokens: [26_000, 58_000],
    prompts: [
      "What changed on competitors' pricing pages this week?",
      "Summarize this week's analytics launches.",
    ],
  },
  {
    key: "iris",
    chat: "Travel, earlier",
    days: [2, 4],
    model: "gpt-5.5",
    tokens: [14_000, 28_000],
    prompts: ["Check my calendar for conflicts next week.", "Find a hotel near the venue."],
  },
];

/** A day's date and weekday (Sunday 0) in the showcase's zone. */
function wallDay(date: Date): { y: number; m: number; d: number; dow: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), dow };
}

/** That day at `hour:minute` on the showcase zone's clock, whatever zone the seed runs in. */
function atWallClock(day: Date, hour: number, minute: number): Date {
  const { y, m, d } = wallDay(day);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let at = wanted;
  // Twice, so a guess across a clock change settles.
  for (let i = 0; i < 2; i++) {
    const shown = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(new Date(at))
      .reduce<Record<string, number>>((all, p) => ({ ...all, [p.type]: Number(p.value) }), {});
    at += wanted - Date.UTC(shown.year!, shown.month! - 1, shown.day!, shown.hour!, shown.minute!);
  }
  return new Date(at);
}

/** The day the plan's weekly window ran out, and the run went on with the API key. */
const LIMIT_DAY = 18;

type Turn = { runId: string; threadId: string; turnId: string };

/** One run's tool work: a shell command, an open-bot tool in a code cell, or a search in two. */
async function tools(
  log: LogSeeder,
  who: Who,
  turn: Turn,
  at: Date,
  rand: () => number,
  expiredAt: Date | undefined,
): Promise<{ output: unknown[]; followUp: unknown[] }> {
  const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
  if (who.key === "kit") {
    const callId = id("call");
    const failed = rand() < 0.22;
    const cmd = failed ? "pnpm vitest run recurrence" : "pnpm vitest run";
    const output = failed
      ? " FAIL  src/recurrence.test.ts > keeps 9:00 across the October change\nAssertionError: expected 10:00 to be 09:00"
      : " Test Files  4 passed (4)\n      Tests  85 passed (85)";
    await log.item(
      turn,
      { type: "commandExecution", id: callId, command: cmd, cwd: "/home/kit/tidepool" },
      plus(at, 2_400),
      1_800 + Math.round(rand() * 6_000),
      {
        status: failed ? "failed" : "completed",
        exitCode: failed ? 1 : 0,
        aggregatedOutput: output,
      },
      expiredAt,
    );
    return {
      output: [functionCall(callId, "exec_command", { cmd })],
      followUp: [functionOutput(callId, output)],
    };
  }
  if (who.key === "scout") {
    // Two cells at once: a search made then could be either's.
    const [a, b] = [id("exec"), id("exec")];
    const failed = rand() < 0.3;
    await log.item(
      turn,
      {
        type: "mcpToolCall",
        id: id("mcp"),
        server: "notion",
        tool: "search",
        arguments: { query: "pricing" },
      },
      plus(at, 3_100),
      600 + Math.round(rand() * 900),
      failed
        ? {
            status: "failed",
            error: { message: "Notion is rate limiting requests. Try again in 30 seconds." },
          }
        : { status: "completed", result: { content: [{ type: "text", text: "4 pages found" }] } },
      expiredAt,
    );
    await log.item(
      turn,
      { type: "webSearch", id: id("ws"), query: "analytics pricing changes" },
      plus(at, 3_400),
      900,
      { status: "completed" },
      expiredAt,
    );
    return {
      output: [
        execCall(a, "await tools.notion.search({ query: 'pricing' })"),
        execCall(b, "await tools.web.search({ query: 'analytics pricing changes' })"),
      ],
      followUp: [
        execOutput(a, "Script completed\n4 pages"),
        execOutput(b, "Script completed\n9 results"),
      ],
    };
  }
  // Mira and Iris: one code cell calling open-bot tools.
  const cell = id("exec");
  const tool = who.key === "mira" ? "send_email" : "list_events";
  const failed = who.key === "mira" && rand() < 0.18;
  await log.item(
    turn,
    {
      type: "dynamicToolCall",
      id: id("dyn"),
      namespace: "openbot",
      tool,
      arguments: { draft: "d_31" },
    },
    plus(at, 2_900),
    300 + Math.round(rand() * 500),
    failed
      ? {
          status: "failed",
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "The recipient's server refused the message: mailbox full.",
            },
          ],
        }
      : {
          status: "completed",
          success: true,
          contentItems: [{ type: "inputText", text: "Done." }],
        },
    expiredAt,
  );
  return {
    output: [execCall(cell, `await tools.openbot.${tool}({ draft: "d_31" })`)],
    followUp: [execOutput(cell, failed ? "Script failed\nmailbox full" : "Script completed")],
  };
}

export async function seedModelLogHistory(ctx: SeedContext, log: LogSeeder) {
  const team = ctx.bots as Record<string, { id: string }>; // vocabulary: allow
  const rand = seeded(20_261_117);
  const expiredOn = ago({ d: 1, h: 3 });
  // Weekly plan use, reset each Monday, and the 5-hour window, by the hour it was read.
  let weekly = 0;
  let week = -1;
  for (const who of CAST) {
    const teammateId = team[who.key]!.id;
    const chatId = randomUUID();
    const created = ago({ d: WEEKS * 7 + 2 });
    await ctx.db.insert(chats, {
      id: chatId,
      kind: "direct",
      title: who.chat,
      titled: true,
      main: false,
      teammateId,
      createdAt: created,
      lastActivityAt: ago({ d: 3 }),
      archivedAt: ago({ d: 2 }),
    });
    ctx.chats[`${who.key}History`] = { id: chatId };
  }
  // Day by day, oldest first, so the plan's windows fill in order.
  for (let d = WEEKS * 7; d >= 3; d--) {
    const day = ago({ d });
    const { dow } = wallDay(day);
    const monday = Math.floor((day.getTime() / 86_400_000 + 3) / 7);
    if (monday !== week) {
      week = monday;
      weekly = 4 + rand() * 6;
    }
    let hourly = 0;
    for (const [n, who] of CAST.entries()) {
      if (!who.days.includes(dow)) continue;
      const teammateId = team[who.key]!.id;
      const at = atWallClock(day, 8 + n * 2 + Math.floor(rand() * 2), Math.floor(rand() * 60));
      const expiredAt = d > RETENTION_DAYS ? expiredOn : undefined;
      const onKey = d === LIMIT_DAY && who.key !== "mira";
      const runId = randomUUID();
      const prompt = who.prompts[d % who.prompts.length]!;
      const failedRun = who.key === "kit" && d % 11 === 4;
      await ctx.db.insert(runs, {
        id: runId,
        chatId: ctx.chats[`${who.key}History`]!.id,
        teammateId,
        trigger: "user",
        prompt,
        status: failedRun ? "failed" : "completed",
        error: failedRun ? "The model stopped answering. Try again." : null,
        authMode: onKey ? "api_key" : "plan",
        attachments: [],
        createdAt: at,
        startedAt: plus(at, 1_200),
        completedAt: plus(at, 95_000),
      });
      const turn = { runId, threadId: randomUUID(), turnId: randomUUID() };
      await log.turn(
        runId,
        turn.threadId,
        turn.turnId,
        onKey ? "api_key" : "plan",
        plus(at, 1_500),
      );
      const [low, high] = who.tokens;
      const input = Math.round(low + rand() * (high - low));
      weekly = Math.min(100, weekly + input / 9_000);
      hourly = Math.min(100, hourly + 8 + rand() * 22);
      const route = onKey ? ("api" as const) : ("plan" as const);
      const limits = onKey ? undefined : planLimits(Math.round(hourly), Math.round(weekly));
      const base = {
        teammateId,
        threadId: turn.threadId,
        kind: "turn" as const,
        route,
        model: who.model,
        expiredAt,
        instructions: `You are ${who.key[0]!.toUpperCase()}${who.key.slice(1)}.`,
      };
      const context = [said("user", prompt)];
      const work = await tools(log, who, turn, plus(at, 3_000), rand, expiredAt);
      await log.request({
        ...base,
        turnId: turn.turnId,
        startedAt: plus(at, 2_000),
        firstByteMs: 700 + Math.round(rand() * 900),
        endMs: 2_600,
        status: 200,
        input: context,
        output: work.output,
        tokens: {
          input,
          cached: Math.round(input * (0.5 + rand() * 0.35)),
          output: 300 + Math.round(rand() * 500),
          reasoning: Math.round(rand() * 400),
        },
        rateLimits: limits,
      });
      if (failedRun) {
        await log.request({
          ...base,
          turnId: turn.turnId,
          startedAt: plus(at, 12_000),
          firstByteMs: 30_000,
          endMs: 30_100,
          status: 502,
          input: [...context, ...work.output, ...work.followUp],
          output: [],
          error: {
            type: "server_error",
            message: "Upstream connect error or disconnect before headers.",
          },
        });
        continue;
      }
      const answer = who.key === "kit" ? "Done, and the suite is green." : "Here's what I found.";
      await log.request({
        ...base,
        turnId: turn.turnId,
        startedAt: plus(at, 12_000),
        firstByteMs: 900,
        endMs: 4_200,
        status: 200,
        input: [...context, ...work.output, ...work.followUp],
        output: [said("assistant", answer)],
        tokens: { input: input + 1_400, cached: input, output: 180 + Math.round(rand() * 300) },
        rateLimits: limits,
      });
    }
  }
  // The owner keeps bodies for 30 days; the sweep above has run.
  await ctx.db.orm
    .update(settings)
    .set({ modelLogRetentionDays: RETENTION_DAYS })
    .where(eq(settings.id, 1));
}
