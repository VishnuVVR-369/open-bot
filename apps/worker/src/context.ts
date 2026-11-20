import { notify, type Db, type NotificationKind } from "@open-bot/db";
import type { EventEmitter } from "node:events";
import {
  type AppEvent,
  type ApprovalKind,
  type FinishedRunStatus,
  NOTIFY_CHANNELS,
  type WorkerSignal,
} from "@open-bot/domain";
import type pg from "pg";
import type { ComputerLifecycle } from "./computer/lifecycle";
import type { CodexManager } from "./codex/client";
import type { ComputerClient } from "./computer/client";
import type { Env } from "./env";
import type { Logger } from "./logger";

/** A notification as it's created, with what a channel like Telegram needs to act on it. */
export interface NotificationEvent {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  teammateId: string | null;
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
    status: FinishedRunStatus,
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
  await notify(ctx.pool, NOTIFY_CHANNELS.app, JSON.stringify(event)).catch(() => {});
}

export async function signalWorker(
  ctx: Pick<Context, "pool">,
  signal: WorkerSignal,
): Promise<void> {
  await notify(ctx.pool, NOTIFY_CHANNELS.worker, signal);
}
