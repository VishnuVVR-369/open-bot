import { PendingMoves, TaskStartKeys } from "@open-bot/domain";

/** The moves this tab sent that the board it last read doesn't have yet (`PendingMoves`). */
export const pendingMoves = new PendingMoves();

/** The id of each ask to start a task, kept for retries until it goes through. */
export const startKeys = new TaskStartKeys(() => crypto.randomUUID());
