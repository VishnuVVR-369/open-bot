import { bots, runs } from "@open-bot/db";
import type { RunStatus } from "@open-bot/domain";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "../context";
import { enqueueRun } from "./queue";

/** Sends the answer to a teammate's question back to them, in the chat they asked from. */
export async function answerBack(
  ctx: Context,
  question: { id: string; parentRunId: string | null },
  answerer: { name: string },
  status: Extract<RunStatus, "completed" | "failed" | "interrupted">,
  text: string | null,
  error?: string,
): Promise<void> {
  if (!question.parentRunId) return;
  const [asker] = await ctx.db
    .select({ chatId: runs.chatId, botId: runs.botId })
    .from(runs)
    .innerJoin(bots, eq(bots.id, runs.botId))
    .where(and(eq(runs.id, question.parentRunId), isNull(bots.archivedAt)));
  if (!asker) return;
  const { name } = answerer;
  const answer =
    status === "completed"
      ? `[${name} answered your question:]\n${text ?? "(No reply.)"}`
      : status === "failed"
        ? `[${name} couldn't answer your question: ${error ?? "the run failed"}. Carry on without it, or ask the user.]`
        : `[The user stopped ${name} before they answered. Carry on without it, or ask the user.]`;
  await enqueueRun(ctx, {
    chatId: asker.chatId,
    botId: asker.botId,
    trigger: "answer",
    prompt: answer,
    parentRunId: question.id,
  });
}
