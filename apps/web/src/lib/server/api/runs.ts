import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { bots, chats, messages, runs } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { memoryReady } from "../memory";
import { worker } from "../worker";
import { ApiError } from "./errors";

type Inputs = ApiInputs["runs"];

/** Run a failed or stopped request again; asking twice finds the first retry. */
export async function retryRun({ runId }: Inputs["retry"]): Promise<{ runId: string }> {
  return worker.runs.retry({ runId });
}

export async function cancelRun({ runId }: Inputs["cancel"]) {
  const [run] = await db
    .update(runs)
    .set({ cancelRequestedAt: new Date() })
    .where(eq(runs.id, runId))
    .returning({ id: runs.id });
  if (!run) throw new ApiError("NOT_FOUND", "That reply is gone.");
  await worker.runs.processCancellations();
  return { ok: true as const };
}

export async function rateRun({ runId, rating }: Inputs["rate"]) {
  const [run] = await db
    .update(runs)
    .set({ rating })
    .where(eq(runs.id, runId))
    .returning({ id: runs.id });
  if (!run) throw new ApiError("NOT_FOUND", "That reply is gone.");
  return { ok: true as const };
}

/**
 * A thumbs down with what to change. Saved as a lesson, the teammate reads it before every task;
 * with `redo`, it's also sent to the chat so the teammate tries again now. The redo message's id
 * makes a retry safe: once it's saved, the same feedback isn't saved or sent again.
 */
export async function giveFeedback(input: Inputs["feedback"]) {
  const request = { text: input.text, remember: input.remember };
  const conflict = () =>
    new ApiError("CONFLICT", "That message id was already used for another message.");
  const matches = (sent: Pick<typeof messages.$inferSelect, "redoOfRunId" | "feedbackRequest">) =>
    sent.redoOfRunId === input.runId &&
    sent.feedbackRequest?.text === request.text &&
    sent.feedbackRequest.remember === request.remember;
  if (input.redo) {
    const [sent] = await db
      .select({
        id: messages.id,
        redoOfRunId: messages.redoOfRunId,
        feedbackRequest: messages.feedbackRequest,
      })
      .from(messages)
      .where(eq(messages.clientId, input.redo.clientId));
    if (sent) {
      if (!matches(sent)) throw conflict();
      await worker.messages.dispatch({ messageId: sent.id }).catch(() => {});
      return { ok: true as const };
    }
  }
  const [run] = await db
    .select({ id: runs.id, botId: runs.botId, chatId: runs.chatId, botName: bots.name })
    .from(runs)
    .innerJoin(bots, eq(bots.id, runs.botId))
    .where(eq(runs.id, input.runId));
  if (!run) throw new ApiError("NOT_FOUND", "That reply is gone.");
  // A redo's lesson is saved by its durable dispatcher before the teammate receives it.
  // A crash after accepting the message must not lose the instruction to remember it.
  if (!input.redo) {
    await db.update(runs).set({ rating: "down" }).where(eq(runs.id, run.id));
    if (input.remember)
      await (
        await memoryReady()
      ).save(
        {
          botId: run.botId,
          kind: "lesson",
          content: input.text,
          key: null,
          pinned: true,
          expiresAt: null,
        },
        { kind: "user" },
        { source: { type: "feedback", runId: run.id } },
      );
    return { ok: true as const };
  }
  const [chat] = await db.select({ kind: chats.kind }).from(chats).where(eq(chats.id, run.chatId));
  const group = chat?.kind === "group";
  const [message] = await db
    .insert(messages)
    .values({
      clientId: input.redo.clientId,
      chatId: run.chatId,
      role: "user",
      // In a group, the message goes to the teammate who replied.
      text: group ? `@${run.botName} ${input.text}` : input.text,
      mentions: group ? [run.botId] : [],
      redoOfRunId: run.id,
      feedbackRequest: request,
    })
    .onConflictDoNothing({ target: messages.clientId })
    .returning({ id: messages.id });
  let messageId = message?.id;
  if (!messageId) {
    const [saved] = await db
      .select()
      .from(messages)
      .where(eq(messages.clientId, input.redo.clientId));
    if (!saved || !matches(saved)) throw conflict();
    messageId = saved.id;
  }
  await db.update(runs).set({ rating: "down" }).where(eq(runs.id, run.id));
  await worker.messages.dispatch({ messageId }).catch((error: unknown) => {
    // Saved, so it isn't lost: the worker dispatches pending messages when it can.
    console.warn("dispatch deferred to the worker's reconciler", {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { ok: true as const };
}

export async function stopSwarm({ swarmId }: ApiInputs["swarms"]["stop"]) {
  await worker.swarms.stop({ swarmId });
  return { ok: true as const };
}
