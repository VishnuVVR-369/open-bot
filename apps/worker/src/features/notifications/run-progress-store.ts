// Which runs owe phones the end of their progress notification, kept in the database so the end
// survives a worker that stops between a run's last status and its `ended` push.
import { runProgressNotifications, runs } from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { eq, notInArray } from "drizzle-orm";
import type { Context } from "../../context";

export interface RunProgressStore {
  /** Before a run's first progress push: phones may show it from now on, so its end is owed. */
  shown(runId: string): Promise<void>;
  /** Whether phones may still show the run's progress, so its end is owed. */
  owed(runId: string): Promise<boolean>;
  /** The run's end was sent. */
  ended(runId: string): Promise<void>;
  /** Runs that are over and still owe their end: the worker stopped before sending it. */
  overdue(): Promise<string[]>;
}

export function runProgressStore(db: Context["db"]): RunProgressStore {
  return {
    async shown(runId) {
      await db.insert(runProgressNotifications).values({ runId }).onConflictDoNothing();
    },
    async owed(runId) {
      const rows = await db
        .select({ runId: runProgressNotifications.runId })
        .from(runProgressNotifications)
        .where(eq(runProgressNotifications.runId, runId));
      return rows.length > 0;
    },
    async ended(runId) {
      await db.delete(runProgressNotifications).where(eq(runProgressNotifications.runId, runId));
    },
    async overdue() {
      const rows = await db
        .select({ runId: runProgressNotifications.runId })
        .from(runProgressNotifications)
        .innerJoin(runs, eq(runs.id, runProgressNotifications.runId))
        .where(notInArray(runs.status, [...ACTIVE_RUN_STATUSES]));
      return rows.map((row) => row.runId);
    },
  };
}
