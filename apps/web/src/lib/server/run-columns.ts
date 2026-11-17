import "server-only";
import { runs } from "@open-bot/db";
import type { RunLane } from "@open-bot/domain";
import { getTableColumns, sql } from "drizzle-orm";

// Web and worker deploy separately. The added columns may not exist
// until the worker's pre-deploy migration finishes. Quiet and delivery bookkeeping stay private; the lane defaults to chat below.
const columns = getTableColumns(runs);
const publicColumns = Object.fromEntries(
  Object.entries(columns).filter(([key]) => !["lane", "quiet", "passedOnAt"].includes(key)),
) as Omit<typeof columns, "lane" | "quiet" | "passedOnAt">;

/** Old workers don't mark quiet runs; the missing column means false during the rollout. */
export const reportedRun = sql<boolean>`not coalesce((to_jsonb(${runs})->>'quiet')::boolean, false)`;

// JSON extraction also works before this additive column exists.
export const runColumns = {
  ...publicColumns,
  lane: sql<RunLane>`coalesce(to_jsonb(${runs})->>'lane', 'chat')`,
};
