// Finishing a run: closes its timeline, frees its screens, stores its status and token usage, then
// answers back and notifies you.
import { runs, usageEntries } from "@open-bot/db";
import { costMicros, type RunStatus, type TimelineItem } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import type { Bot, Chat, Run } from "../../core/db-types";
import { createNotification } from "../../features/notifications";
import { ModelAccess } from "../../features/model-access";
import { errorMessage } from "../../logger";
import { answerBack } from "../answer-back";
import type { RunEventWriter } from "../events";
import { finalText } from "../mapper";
import { quietWithNothingToReport } from "../quiet";

export interface Outcome {
  status: Extract<RunStatus, "completed" | "failed" | "interrupted">;
  error?: string;
  usageLimit?: boolean;
  unauthorized?: boolean;
}

/** Tokens a run used on one access mode. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** What finishing a run reads and writes on the session. */
export interface FinalizeSession {
  readonly ctx: Context;
  readonly run: Run;
  readonly bot: Bot;
  readonly chat: Chat;
  finish: ((outcome: Outcome) => void) | null;
  readonly items: Map<string, TimelineItem>;
  readonly cancelled: boolean;
  readonly writer: RunEventWriter;
  readonly usage: Record<"plan" | "api_key", TokenUsage>;
  readonly services: { touchChat: (chatId: string) => Promise<void> };
  now(): string;
  putItem(item: TimelineItem): void;
  publishedPageId(): string | null;
}

export async function complete(session: FinalizeSession, outcome: Outcome) {
  const { ctx, run, bot, chat } = session;
  session.finish = null;
  const items = [...session.items.values()];
  const text = finalText(items);
  let { status } = outcome;
  let error = outcome.error;
  if (session.cancelled && status !== "completed") {
    status = "interrupted";
    error = undefined;
  }
  if (outcome.usageLimit && status === "failed") {
    error = ModelAccess.blockedMessage("no_key", 0);
  }
  if (status === "failed" && error) {
    session.putItem({
      id: `error-${run.id}`,
      kind: "error",
      message: error,
      status: "failed",
      startedAt: session.now(),
    });
  }
  // Close anything still marked as running, so the timeline never shows a stuck spinner.
  for (const item of items) {
    if (item.status === "running") {
      session.putItem({
        ...item,
        status: status === "completed" ? "completed" : "failed",
        completedAt: session.now(),
      } as TimelineItem);
    }
  }
  // Free the desktop and store the final state first, so the event below reaches clients
  // that then read a consistent run row and lease.
  await ctx.computer.releaseRun(run.id).catch((error: unknown) =>
    ctx.log.warn("couldn't release the run's screens", {
      runId: run.id,
      error: errorMessage(error),
    }),
  );
  await ctx.db
    .update(runs)
    .set({
      status,
      error: error ?? null,
      waitingFor: null,
      finalText: text,
      completedAt: new Date(),
    })
    .where(eq(runs.id, run.id));
  await session.services.touchChat(chat.id);
  const total = {
    inputTokens: session.usage.plan.inputTokens + session.usage.api_key.inputTokens,
    cachedInputTokens:
      session.usage.plan.cachedInputTokens + session.usage.api_key.cachedInputTokens,
    outputTokens: session.usage.plan.outputTokens + session.usage.api_key.outputTokens,
  };
  session.writer.write({ type: "usage", ...total });
  session.writer.write({ type: "status", status, ...(error ? { error } : {}) });
  await session.writer.drain();
  for (const mode of ["plan", "api_key"] as const) {
    const usage = session.usage[mode];
    if (usage.inputTokens + usage.outputTokens === 0) continue;
    await ctx.db
      .insert(usageEntries)
      .values({
        runId: run.id,
        botId: bot.id,
        authMode: mode,
        ...usage,
        // The plan is a flat subscription; only the API key costs money per token.
        costMicros: mode === "api_key" ? costMicros(usage) : 0,
        idempotencyKey: `run:${run.id}:${mode}`,
      })
      .onConflictDoNothing();
  }

  if (run.trigger === "question") await answerBack(ctx, run, bot, status, text, error);
  ctx.events.emit("runFinished", run, status, text, error);

  if (status === "failed" && run.trigger !== "swarm") {
    await createNotification(ctx, {
      kind: "run_failed",
      title: `${bot.name} couldn't finish`,
      body: error ?? "It stopped before it was done.",
      botId: bot.id,
      chatId: chat.id,
      runId: run.id,
    });
  } else if (
    status === "completed" &&
    run.trigger !== "question" &&
    // A helper's part comes back to its teammate, not to you.
    run.trigger !== "swarm" &&
    !(await quietWithNothingToReport(ctx, run, text))
  ) {
    // An answer to a teammate isn't news for you; their reply to you is.
    await createNotification(ctx, {
      // A page made in this run is what you'll want to open.
      pageId: session.publishedPageId(),
      kind: "run_finished",
      title:
        run.trigger === "schedule"
          ? `${bot.name} finished a scheduled task`
          : run.trigger === "watch"
            ? `${bot.name} looked into a page change`
            : run.trigger === "webhook"
              ? `${bot.name} handled a webhook`
              : `${bot.name} replied`,
      body: (text ?? "Done.").slice(0, 280),
      botId: bot.id,
      chatId: chat.id,
      runId: run.id,
    });
  }
  await publishApp(ctx, { type: "chats" });
}
