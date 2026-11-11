import {
  CHANNELS,
  notify,
  runEvents,
  runs,
  type Attachment,
  type Queryable,
  type RunLane,
  type RunTrigger,
} from "@open-bot/db";
import { sql } from "drizzle-orm";
import { signalWorker, type Context } from "../context";

export interface RunInput {
  /** Stable id for durable continuation delivery. */
  id?: string;
  chatId: string;
  botId: string;
  trigger: RunTrigger;
  prompt: string;
  attachments?: Attachment[];
  messageId?: string | null;
  scheduleId?: string | null;
  triggerId?: string | null;
  parentRunId?: string | null;
  /** A screen of its own, for a swarm helper. */
  screenId?: string | null;
  /**
   * The lane it works in. Without one, a run continuing another run of the same teammate in the
   * same chat (`parentRunId`) works in that run's lane, and any other run in the conversation.
   */
  lane?: RunLane;
  /**
   * It starts with data from your accounts in hand (a Gmail trigger, a swarm's results). Runs
   * started by a run that read such data inherit this anyway.
   */
  readOutsideData?: boolean;
}

/** The run's teammate. The column's name predates the glossary. */
const runTeammate = runs.botId; // vocabulary: allow

/** The lane a new run works in: its own, its parent's in the same chat, or the conversation. */
function laneOf(input: RunInput) {
  const { chatId, parentRunId, lane } = input;
  if (lane) return lane;
  if (!parentRunId) return "chat";
  const teammateId = input.botId; // vocabulary: allow
  return sql<RunLane>`coalesce((select ${runs.lane} from ${runs} where ${runs.id} = ${parentRunId} and ${runs.chatId} = ${chatId} and ${runTeammate} = ${teammateId}), 'chat')`;
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
      botId: input.botId,
      trigger: input.trigger,
      prompt: input.prompt,
      attachments: input.attachments ?? [],
      messageId: input.messageId ?? null,
      scheduleId: input.scheduleId ?? null,
      triggerId: input.triggerId ?? null,
      parentRunId: input.parentRunId ?? null,
      screenId: input.screenId ?? null,
      lane: laneOf(input),
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

/** Tell open chats about a saved run, and wake the executor. */
export async function announceRun(ctx: Pick<Context, "pool">, chatId: string): Promise<void> {
  await notify(ctx.pool, CHANNELS.chat, chatId);
  await signalWorker(ctx, "runs");
}

/** Queue a run and wake the executor. */
export async function enqueueRun(
  ctx: Pick<Context, "db" | "pool">,
  input: RunInput,
): Promise<string> {
  const id = await insertRun(ctx.db, input);
  await announceRun(ctx, input.chatId);
  return id;
}
