// Which runs owe phones the end of their progress notification, kept in the database so the end
// survives a worker that stops between a run's last status and its `ended` push.
import { runProgressNotifications, runs } from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { and, eq, gte, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Context } from "../../context";
import { END_OWED_FOR_MS } from "./run-progress-push";

export interface RunProgressStore {
  /**
   * Before each live progress push: phones may show the run from now on, so its end is owed.
   * A push goes only once this returns true. False when the run's end was already recorded: a
   * save that lands after it never makes the end owed again.
   */
  shown(runId: string): Promise<boolean>;
  /** Whether phones may still show the run's progress, so its end is owed. */
  owed(runId: string): Promise<boolean>;
  /** The run's end was sent, or the run ended before any push went: nothing is owed for it. */
  ended(runId: string): Promise<void>;
  /**
   * Runs that are over and still owe their end: the worker stopped before sending it. Forgets
   * the ends no phone could use any more, whose last update has timed out on every phone.
   */
  overdue(): Promise<string[]>;
}

export interface RunProgressStoreOptions {
  /** The longest a query waits for a row another transaction holds. */
  lockTimeoutMs: number;
  /** The longest a query runs. A query that hits either limit fails, and its caller tries later. */
  statementTimeoutMs: number;
}

export function runProgressStore(
  db: Context["db"],
  options: RunProgressStoreOptions = { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 },
): RunProgressStore {
  /** Before this, a phone's copy has timed out: its end is useless. */
  const cutoff = sql`now() - make_interval(secs => ${END_OWED_FOR_MS / 1000})`;
  /** Each query has a deadline, so a held row or a slow database never holds a run's pushes. */
  const bounded = <T>(work: (tx: Context["db"]) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = ${Math.round(options.lockTimeoutMs)}`));
      await tx.execute(
        sql.raw(`set local statement_timeout = ${Math.round(options.statementTimeoutMs)}`),
      );
      return work(tx as unknown as Context["db"]);
    });
  const table = runProgressNotifications;
  return {
    shown: (runId) =>
      bounded(async (tx) => {
        const rows = await tx
          .insert(table)
          .values({ runId })
          .onConflictDoUpdate({
            target: table.runId,
            set: { shownAt: sql`now()` },
            // Checked on the row as it is when the save lands, after any end recorded meanwhile.
            setWhere: isNull(table.endedAt),
          })
          .returning({ runId: table.runId });
        return rows.length > 0;
      }),
    owed: (runId) =>
      bounded(async (tx) => {
        const rows = await tx
          .select({ runId: table.runId })
          .from(table)
          .where(and(eq(table.runId, runId), isNull(table.endedAt), gte(table.shownAt, cutoff)));
        return rows.length > 0;
      }),
    ended: (runId) =>
      bounded(async (tx) => {
        await tx
          .insert(table)
          .values({ runId, endedAt: sql`now()` })
          .onConflictDoUpdate({ target: table.runId, set: { endedAt: sql`now()` } });
      }),
    overdue: () =>
      bounded(async (tx) => {
        // Past the cutoff no phone shows the run, and no save is still going for it.
        await tx
          .delete(table)
          .where(
            or(lt(table.shownAt, cutoff), and(isNotNull(table.endedAt), lt(table.endedAt, cutoff))),
          );
        const rows = await tx
          .select({ runId: table.runId })
          .from(table)
          .innerJoin(runs, eq(runs.id, table.runId))
          .where(and(isNull(table.endedAt), notInArray(runs.status, [...ACTIVE_RUN_STATUSES])));
        return rows.map((row) => row.runId);
      }),
  };
}
