// Which runs owe phones the end of their progress notification, kept in the database so the end
// survives a worker that stops between a run's last status and its `ended` push.
import { runProgressNotifications, runs } from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { and, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import type { Context } from "../../context";
import { END_OWED_FOR_MS } from "./run-progress-push";

export interface RunProgressStore {
  /**
   * Before each live progress push: phones may show the run from now on, so its end is owed.
   * A push goes only once this succeeds.
   */
  shown(runId: string): Promise<void>;
  /** Whether phones may still show the run's progress, so its end is owed. */
  owed(runId: string): Promise<boolean>;
  /** The run's end was sent. */
  ended(runId: string): Promise<void>;
  /**
   * Runs that are over and still owe their end: the worker stopped before sending it. Forgets
   * the ends no phone could use any more, whose last update has timed out on every phone.
   */
  overdue(): Promise<string[]>;
}

export function runProgressStore(db: Context["db"]): RunProgressStore {
  /** Before this, a phone's copy has timed out: its end is useless. */
  const cutoff = sql`now() - make_interval(secs => ${END_OWED_FOR_MS / 1000})`;
  return {
    async shown(runId) {
      await db
        .insert(runProgressNotifications)
        .values({ runId })
        .onConflictDoUpdate({
          target: runProgressNotifications.runId,
          set: { shownAt: sql`now()` },
        });
    },
    async owed(runId) {
      const rows = await db
        .select({ runId: runProgressNotifications.runId })
        .from(runProgressNotifications)
        .where(
          and(
            eq(runProgressNotifications.runId, runId),
            gte(runProgressNotifications.shownAt, cutoff),
          ),
        );
      return rows.length > 0;
    },
    async ended(runId) {
      await db.delete(runProgressNotifications).where(eq(runProgressNotifications.runId, runId));
    },
    async overdue() {
      await db.delete(runProgressNotifications).where(lt(runProgressNotifications.shownAt, cutoff));
      const rows = await db
        .select({ runId: runProgressNotifications.runId })
        .from(runProgressNotifications)
        .innerJoin(runs, eq(runs.id, runProgressNotifications.runId))
        .where(notInArray(runs.status, [...ACTIVE_RUN_STATUSES]));
      return rows.map((row) => row.runId);
    },
  };
}
