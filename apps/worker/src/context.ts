import {
  CHANNELS,
  notifications,
  notify,
  runEvents,
  runs,
  type AppEvent,
  type Db,
  type NotificationKind,
  type RunTrigger,
  type WorkerSignal,
} from "@open-bot/db";
import type { Attachment } from "@open-bot/db";
import type { EventEmitter } from "node:events";
import type { RunEventPayload } from "@open-bot/shared";
import type pg from "pg";
import type { CodexManager } from "./codex";
import type { ComputerClient } from "./computer";
import type { Env } from "./env";
import type { Logger } from "./logger";

/** A notification as it's created, with what a channel like Telegram needs to act on it. */
export interface NotificationEvent {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  botId: string | null;
  chatId: string | null;
  runId: string | null;
  /** For approvals: the approval, so it can be decided from the notification. */
  approvalId?: string;
}

/** Things that happen in the worker that other parts react to. */
export type WorkerEvents = {
  notification: [NotificationEvent];
  /** An approval was approved, denied or expired. */
  approvalDecided: [approvalId: string];
  /** A run started executing. */
  runStarted: [run: { id: string; trigger: string }];
  /** A run ended, with its final reply. */
  runFinished: [
    run: { id: string; trigger: string },
    status: "completed" | "failed" | "interrupted",
    text: string | null,
    error?: string,
  ];
};

/** Everything the worker's services share. */
export interface Context {
  env: Env;
  db: Db;
  pool: pg.Pool;
  computer: ComputerClient;
  codex: CodexManager;
  log: Logger;
  events: EventEmitter<WorkerEvents>;
}

/** Tell open browser tabs that something changed. Best effort: a missed signal only delays a refresh. */
export async function publishApp(ctx: Pick<Context, "pool">, event: AppEvent): Promise<void> {
  await notify(ctx.pool, CHANNELS.app, JSON.stringify(event)).catch(() => {});
}

export async function signalWorker(
  ctx: Pick<Context, "pool">,
  signal: WorkerSignal,
): Promise<void> {
  await notify(ctx.pool, CHANNELS.worker, signal);
}

/** Append an event to a run that may not be executing anymore (for example a late approval decision). */
export async function appendRunEvent(
  ctx: Pick<Context, "db" | "pool">,
  runId: string,
  chatId: string,
  payload: RunEventPayload,
): Promise<void> {
  await ctx.db.insert(runEvents).values({ runId, chatId, payload });
  await notify(ctx.pool, CHANNELS.chat, chatId);
}

export async function createNotification(
  ctx: Pick<Context, "db" | "pool" | "events">,
  input: {
    kind: NotificationKind;
    title: string;
    body?: string;
    botId?: string | null;
    chatId?: string | null;
    runId?: string | null;
    approvalId?: string;
  },
): Promise<void> {
  const [row] = await ctx.db
    .insert(notifications)
    .values({
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      botId: input.botId ?? null,
      chatId: input.chatId ?? null,
      runId: input.runId ?? null,
    })
    .returning({ id: notifications.id });
  await publishApp(ctx, { type: "notification", id: row!.id });
  ctx.events.emit("notification", {
    id: row!.id,
    kind: input.kind,
    title: input.title,
    body: input.body ?? "",
    botId: input.botId ?? null,
    chatId: input.chatId ?? null,
    runId: input.runId ?? null,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
  });
}

/** Queue a run and wake the executor. */
export async function enqueueRun(
  ctx: Pick<Context, "db" | "pool">,
  input: {
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
  },
): Promise<string> {
  const [row] = await ctx.db
    .insert(runs)
    .values({
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
    })
    .returning({ id: runs.id });
  await appendRunEvent(ctx, row!.id, input.chatId, { type: "status", status: "queued" });
  await signalWorker(ctx, "runs");
  return row!.id;
}
