import { sql } from "drizzle-orm";
import type { Queryable } from "./queryable";

/**
 * Usage has two producers, and each request counts through exactly one of them:
 *
 * - A worker that writes `usage_entries` counts its runs there. Those entries become the runs'
 *   legacy totals (`runs.legacy_*`, or `legacy_deleted_run_usage` for a run deleted since),
 *   copied by migration 0040 and by its trigger on each entry written later. The requests such a
 *   worker logs leave `model_requests.counts_usage` false, so they never count again.
 * - A worker that no longer writes `usage_entries` sets `counts_usage` on every request it logs,
 *   and keeps the API key cost of requests whose logs were lost in `model_log_gaps.api_cost_micros`
 *   (older workers leave it 0).
 *
 * No clock decides which side a request is on, so neither clock skew between the worker and the
 * database, nor deploying, rolling back to a worker that writes `usage_entries` and deploying
 * again, can count a request twice or not at all. The cap (worker), Settings (web) and each
 * reply's footer (web) all read usage this way.
 *
 * The memory AI's requests are left out: they use their own key (`MEMORY_AI_API_KEY`), not yours,
 * and never counted toward the cap.
 */

/**
 * What the API key spent since `since` (the start of a month), in millionths of a dollar: counted
 * API key requests that started since, the API key cost of lost ones in gaps since (a gap with
 * API key requests stays within one month), and the legacy totals of runs and deleted runs.
 */
export async function apiKeySpendMicros(db: Queryable, since: Date): Promise<number> {
  const at = since.toISOString();
  const result = await db.execute<{ spend: string | number }>(sql`
    select
      (select coalesce(sum(m.cost_micros), 0) from model_requests m
        where m.route = 'api' and m.counts_usage and m.started_at >= ${at}::timestamptz)
      + (select coalesce(sum(g.api_cost_micros), 0) from model_log_gaps g
        where g.api_requests > 0 and g.first_at >= ${at}::timestamptz)
      + (select coalesce(sum(r.legacy_api_key_cost_micros), 0) from runs r
        where r.legacy_usage_at >= ${at}::timestamptz and r.legacy_api_key_cost_micros is not null)
      + (select coalesce(sum(d.cost_micros), 0) from legacy_deleted_run_usage d
        where d.access_mode = 'api_key' and d.at >= ${at}::timestamptz)
      as spend`);
  return Number(result.rows[0]?.spend ?? 0);
}
