// Routes a message you sent: steers it into a teammate's running turn or queues a run, exactly
// once per teammate, and recovers dispatches and steers a restart interrupted.
import { teammates, chatMembers, chats, messageDispatches, messages, runs } from "@open-bot/db";
import { and, asc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { markDispatched, markSteered, touchChat } from "../../features/chat";
import type { MemoryCoordinator } from "../../features/memory";
import { redoPrompt } from "../../instructions";
import { errorMessage } from "../../logger";
import { announceRun, insertRun } from "../queue";
import type { SessionRegistry } from "../registry";

/** How long a saved message may wait for its dispatch before the worker dispatches it itself. */
export const DISPATCH_GRACE_MS = 15_000;

/** What dispatching reads from the executor. */
export interface DispatchExecutor {
  readonly ctx: Context;
  readonly sessions: SessionRegistry;
  readonly memory: MemoryCoordinator;
  pump(): void;
  dispatchMessage(messageId: string): Promise<void>;
}

/**
 * Route a message you sent: join a teammate's running turn, or start a run. Safe to call more than
 * once for the same message: each teammate is claimed in `message_dispatches` before it gets the
 * message, so it gets it once.
 */
export async function dispatchMessage(
  executor: DispatchExecutor,
  messageId: string,
): Promise<void> {
  const [message] = await executor.ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!message) return;
  if (message.role !== "user") {
    await markDispatched(executor.ctx.db, message.id);
    return;
  }
  const [chat] = await executor.ctx.db.select().from(chats).where(eq(chats.id, message.chatId));
  if (!chat) return;

  if (
    message.dispatchStatus === "pending" &&
    message.feedbackRequest?.remember &&
    message.redoOfRunId
  ) {
    const [source] = await executor.ctx.db
      .select({ botId: runs.teammateId })
      .from(runs)
      .where(eq(runs.id, message.redoOfRunId));
    if (!source) throw new Error("The reply this feedback belongs to is gone.");
    // Memory saving deduplicates the content in Postgres, including concurrent dispatches.
    // Keep the message pending until this succeeds so the reconciler can recover a crash.
    await executor.memory.store.save(
      {
        teammateId: source.botId,
        kind: "lesson",
        content: message.feedbackRequest.text,
        key: null,
        pinned: true,
        expiresAt: null,
      },
      { kind: "user" },
      { source: { type: "feedback", runId: message.redoOfRunId } },
    );
  }

  let targets: string[];
  if (chat.kind === "group") {
    const members = await executor.ctx.db
      .select({ id: teammates.id, isLead: teammates.isLead })
      .from(chatMembers)
      .innerJoin(teammates, eq(teammates.id, chatMembers.teammateId))
      .where(and(eq(chatMembers.chatId, chat.id), isNull(teammates.archivedAt)))
      .orderBy(asc(chatMembers.createdAt));
    const memberIds = new Set(members.map((member) => member.id));
    const mentioned = message.mentions.filter((id) => memberIds.has(id));
    const lead = members.find((member) => member.isLead) ?? members[0];
    targets = mentioned.length ? mentioned : lead ? [lead.id] : [];
  } else {
    targets = chat.teammateId ? [chat.teammateId] : [];
  }
  const prompt = message.redoOfRunId ? redoPrompt(message.text) : message.text;

  let delivered = false;
  for (const teammateId of targets) {
    const session = executor.sessions.find(chat.id, teammateId, "chat");
    if (session && message.attachments.length === 0) {
      // Claim the teammate before steering: a steer can't be undone or repeated safely.
      const [claimed] = await executor.ctx.db
        .insert(messageDispatches)
        .values({ messageId: message.id, teammateId, kind: "steer", status: "sending" })
        .onConflictDoNothing()
        .returning({ messageId: messageDispatches.messageId });
      if (!claimed) {
        // Claimed before: delivered, being delivered, or a refused steer whose run is still owed.
        if (await queueRun(executor, message, teammateId, prompt, { claimed: false }))
          delivered = true;
        continue;
      }
      if (await session.steer(message.id, prompt)) {
        await markSteered(executor.ctx.db, message.id, session.run.id);
        await executor.ctx.db
          .update(messageDispatches)
          .set({ status: "done", runId: session.run.id })
          .where(claimOf(message.id, teammateId));
        delivered = true;
        continue;
      }
      // The turn ended or refused the steer: it becomes a run of its own. Recorded first, so if the
      // run can't be saved now, the next dispatch of this message saves it, without steering again.
      await executor.ctx.db
        .update(messageDispatches)
        .set({ status: "failed" })
        .where(claimOf(message.id, teammateId, eq(messageDispatches.status, "sending")));
      await queueRun(executor, message, teammateId, prompt, { claimed: true });
      delivered = true;
      continue;
    }
    if (await queueRun(executor, message, teammateId, prompt, { claimed: false })) delivered = true;
  }
  const first = await markDispatched(executor.ctx.db, message.id);
  if (delivered || first) {
    await touchChat(executor.ctx.db, chat.id);
    await publishApp(executor.ctx, { type: "chats" });
  }
  executor.pump();
}

/** A teammate's dispatch record for a message, optionally narrowed further. */
function claimOf(messageId: string, teammateId: string, ...more: SQL[]): SQL | undefined {
  return and(
    eq(messageDispatches.messageId, messageId),
    eq(messageDispatches.teammateId, teammateId),
    ...more,
  );
}

/**
 * Queue the run that answers a message, in the same transaction as its dispatch record, so the
 * run exists if and only if the record does. False when another dispatch got there first.
 * `claimed`: this dispatch holds the teammate's steer claim (`sending`, or `failed` when the turn
 * refused it). Otherwise it claims the teammate now, or takes over a refused steer's claim, whose
 * run couldn't be saved when it was refused.
 */
async function queueRun(
  executor: DispatchExecutor,
  message: typeof messages.$inferSelect,
  teammateId: string,
  prompt: string,
  { claimed }: { claimed: boolean },
): Promise<boolean> {
  const runId = await executor.ctx.db.transaction(async (tx) => {
    const takeOver = (...statuses: ("sending" | "failed")[]) =>
      tx
        .update(messageDispatches)
        .set({ kind: "run", status: "done" })
        .where(claimOf(message.id, teammateId, inArray(messageDispatches.status, statuses)))
        .returning({ messageId: messageDispatches.messageId });
    if (claimed) {
      const [row] = await takeOver("sending", "failed");
      if (!row) return null;
    } else {
      const [row] = await tx
        .insert(messageDispatches)
        .values({ messageId: message.id, teammateId, kind: "run", status: "done" })
        .onConflictDoNothing()
        .returning({ messageId: messageDispatches.messageId });
      const [refused] = row ? [row] : await takeOver("failed");
      if (!refused) return null;
    }
    const id = await insertRun(tx, {
      chatId: message.chatId,
      botId: teammateId, // vocabulary: allow
      trigger: "user",
      prompt,
      attachments: message.attachments,
      messageId: message.id,
    });
    await tx.update(messageDispatches).set({ runId: id }).where(claimOf(message.id, teammateId));
    return id;
  });
  if (!runId) return false;
  await announceRun(executor.ctx, message.chatId);
  return true;
}

/**
 * Steers that were being delivered when the worker stopped, and refused ones whose run wasn't
 * saved. The turn they joined ended with that worker, so the message can't have been answered: it
 * becomes a run of its own.
 * Call on startup, before anything can steer.
 */
export async function recoverSteers(executor: DispatchExecutor): Promise<void> {
  const rows = await executor.ctx.db
    .select({ message: messages, teammateId: messageDispatches.teammateId })
    .from(messageDispatches)
    .innerJoin(messages, eq(messages.id, messageDispatches.messageId))
    .where(
      and(
        eq(messageDispatches.kind, "steer"),
        inArray(messageDispatches.status, ["sending", "failed"]),
      ),
    );
  for (const { message, teammateId } of rows) {
    const prompt = message.redoOfRunId ? redoPrompt(message.text) : message.text;
    await queueRun(executor, message, teammateId, prompt, { claimed: true });
  }
  if (rows.length)
    executor.ctx.log.warn(`queued ${rows.length} messages whose steer the restart interrupted`);
}

/** Dispatch messages that were saved but never dispatched, like after a crash in between. */
export async function reconcileDispatches(
  executor: DispatchExecutor,
  olderThanMs = DISPATCH_GRACE_MS,
): Promise<void> {
  const stale = await executor.ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.dispatchStatus, "pending"),
        lt(messages.createdAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(100);
  for (const { id } of stale) {
    try {
      await executor.dispatchMessage(id);
    } catch (error) {
      executor.ctx.log.error("dispatching a pending message failed", {
        messageId: id,
        error: errorMessage(error),
      });
    }
  }
  if (stale.length) executor.ctx.log.warn(`dispatched ${stale.length} pending messages`);
}
