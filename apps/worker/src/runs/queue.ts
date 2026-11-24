import { NOTIFY_CHANNELS, type RunTrigger, type RunLane } from "@open-bot/domain";
import {
  errorMessage,
  notify,
  runEvents,
  runs,
  type Attachment,
  type Queryable,
} from "@open-bot/db";
import { sql } from "drizzle-orm";
import { signalWorker, type Context } from "../context";

export interface RunInput {
  /** Stable id for durable continuation delivery. */
  id?: string;
  chatId: string;
  teammateId: string;
  trigger: RunTrigger;
  /** Explicit lane, or inherit a continuation of the same teammate in the same chat. */
  lane?: RunLane;
  prompt: string;
  attachments?: Attachment[];
  messageId?: string | null;
  scheduleId?: string | null;
  triggerId?: string | null;
  parentRunId?: string | null;
  /** The board task it was asked to work on. */
  taskId?: string | null;
  /** A screen of its own, for a swarm helper. */
  screenId?: string | null;
  /**
   * It starts with data from your accounts in hand (a Gmail trigger, a swarm's results). Runs
   * started by a run that read such data inherit this anyway.
   */
  readOutsideData?: boolean;
}

/** The lane a new run works in, including durable continuations. */
function laneOf(input: RunInput) {
  if (input.lane) return input.lane;
  if (!input.parentRunId) return "chat";
  return sql<RunLane>`coalesce((select ${runs.lane} from ${runs} where ${runs.id} = ${input.parentRunId} and ${runs.chatId} = ${input.chatId} and ${runs.teammateId} = ${input.teammateId}), 'chat')`;
}

/**
 * Save a queued run and its first event, without telling anyone yet. Takes a transaction, so the
 * run can be saved together with what caused it; call `announceRun` once it's committed.
 */
export async function insertRun(db: Queryable, input: RunInput): Promise<string> {
  const [row] = await db
    .insert(runs)
    .values({
      ...(input.id ? { id: input.id } : {}),
      chatId: input.chatId,
      teammateId: input.teammateId,
      trigger: input.trigger,
      lane: laneOf(input),
      prompt: input.prompt,
      attachments: input.attachments ?? [],
      messageId: input.messageId ?? null,
      scheduleId: input.scheduleId ?? null,
      triggerId: input.triggerId ?? null,
      parentRunId: input.parentRunId ?? null,
      taskId: input.taskId ?? null,
      screenId: input.screenId ?? null,
      // What a run read from your accounts travels with everything it starts.
      readOutsideData: input.readOutsideData
        ? true
        : input.parentRunId
          ? sql<boolean>`coalesce((select ${runs.readOutsideData} from ${runs} where ${runs.id} = ${input.parentRunId}), false)`
          : false,
    })
    .onConflictDoNothing({ target: runs.id })
    .returning({ id: runs.id });
  if (!row && input.id) return input.id;
  await db.insert(runEvents).values({
    runId: row!.id,
    chatId: input.chatId,
    payload: { type: "status", status: "queued" },
  });
  return row!.id;
}

/**
 * Tell open chats about a saved run, and wake the executor. It never fails: the run is saved, which
 * is what counts, so a lost announcement only delays it until the executor's safety sweep (every
 * 15 seconds) finds it queued. A caller that failed here after saving would make its caller try
 * again and queue the run twice.
 */
export async function announceRun(
  ctx: Pick<Context, "pool" | "log">,
  chatId: string,
): Promise<void> {
  try {
    await notify(ctx.pool, NOTIFY_CHANNELS.chat, chatId);
    await signalWorker(ctx, "runs");
  } catch (error) {
    ctx.log.warn("run announcement failed; the safety sweep starts it", {
      chatId,
      error: errorMessage(error),
    });
  }
}

/** Queue a run and wake the executor. */
export async function enqueueRun(
  ctx: Pick<Context, "db" | "pool" | "log">,
  input: RunInput,
): Promise<string> {
  const id = await insertRun(ctx.db, input);
  await announceRun(ctx, input.chatId);
  return id;
}
