import { runs, type Queryable, type Tx } from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Asks every unfinished run of a teammate to stop, in the caller's transaction. The executor
 * stops them when it next processes cancellations (the `cancel` worker signal wakes it).
 */
export async function requestTeammateRunsCancel(tx: Tx, teammateId: string, at: Date) {
  await tx
    .update(runs)
    .set({ cancelRequestedAt: at })
    .where(and(eq(runs.botId, teammateId), inArray(runs.status, [...ACTIVE_RUN_STATUSES]))); // vocabulary: allow
}

/**
 * Asks these runs to stop, and says which exist. The executor stops them when it next processes
 * cancellations.
 */
export async function requestRunsCancel(db: Queryable, runIds: string[]): Promise<string[]> {
  if (!runIds.length) return [];
  const rows = await db
    .update(runs)
    .set({ cancelRequestedAt: new Date() })
    .where(inArray(runs.id, runIds))
    .returning({ id: runs.id });
  return rows.map((row) => row.id);
}
