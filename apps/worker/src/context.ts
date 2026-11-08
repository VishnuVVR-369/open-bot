import {
  CHANNELS,
  notifications,
  notify,
  runEvents,
  runs,
  type AppEvent,
  type Db,
  type Queryable,
  type NotificationKind,
  type RunTrigger,
  type WorkerSignal,
} from "@open-bot/db";
import type { Attachment } from "@open-bot/db";
import type { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import type { ApprovalKind, RunEventPayload } from "@open-bot/domain";
import type pg from "pg";
import type { ComputerLifecycle } from "./computer-lifecycle";
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
  /** For approvals: what kind, since some (purchases) need more care to approve. */
  approvalKind?: ApprovalKind;
  /** For takeover requests: the request. */
  takeoverId?: string;
  /** A page the teammate published, which the notification opens. */
  pageId?: string;
}

/** Things that happen in the worker that other parts react to. */
export type WorkerEvents = {
  takeoverEnded: [takeoverId: string];
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
  lifecycle?: ComputerLifecycle;
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
    approvalKind?: ApprovalKind;
    takeoverId?: string;
    pageId?: string | null;
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
      pageId: input.pageId ?? null,
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
    ...(input.approvalKind ? { approvalKind: input.approvalKind } : {}),
    ...(input.takeoverId ? { takeoverId: input.takeoverId } : {}),
    ...(input.pageId ? { pageId: input.pageId } : {}),
  });
}

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
   * It starts with data from your accounts in hand (a Gmail trigger, a swarm's results). Runs
   * started by a run that read such data inherit this anyway.
   */
  readOutsideData?: boolean;
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
