import "server-only";
import type { UsageView } from "@open-bot/api";
import { type LegacyModeUsage, type RunUsage, runUsage } from "@open-bot/domain";
import { sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { requestOfTurn, unturnedTurnSql } from "./attribution";

/**
 * Usage outside the model logs' own tabs: each reply's footer and Settings' monthly usage. Both
 * count as the cap does (see `packages/db/src/usage.ts`): the legacy totals (copied from
 * `usage_entries`), plus the model requests that count toward usage (`counts_usage`). A worker
 * that wrote `usage_entries` left its requests unmarked, so each request counts once, through
 * the one producer that counted it. The memory AI's requests are left out, as they always were:
 * they aren't a teammate's run.
 */

type RunRow = {
  id: string;
  requests: string | number | null;
  tokens: string | number | null;
  cost_micros: string | number | null;
  estimated: boolean | null;
  plan_input: string | number | null;
  plan_cached: string | number | null;
  plan_output: string | number | null;
  plan_cost: string | number | null;
  api_input: string | number | null;
  api_cached: string | number | null;
  api_output: string | number | null;
  api_cost: string | number | null;
};

function legacyMode(
  input: RunRow["plan_input"],
  cached: RunRow["plan_cached"],
  output: RunRow["plan_output"],
  cost: RunRow["plan_cost"],
): LegacyModeUsage | null {
  if (input === null) return null;
  return {
    inputTokens: Number(input),
    cachedInputTokens: Number(cached ?? 0),
    outputTokens: Number(output ?? 0),
    costMicros: Number(cost ?? 0),
  };
}

/**
 * Tokens and API key cost per run, as each reply's footer shows them: its legacy totals plus its
 * counted model requests, and whether any of those is an estimate. A run's requests are found
 * through its turns as everywhere in the model logs (`requestOfTurn`), plus its last turn when
 * that has no `run_turns` row.
 */
export async function runUsageByRun(runIds: string[]): Promise<Map<string, RunUsage>> {
  if (runIds.length === 0) return new Map();
  const result = await db.execute<RunRow>(sql`
    with picked as (
      select r.id, r.codex_thread_id, r.codex_turn_id, r.started_at, r.created_at, r.completed_at,
        r.legacy_plan_input_tokens as plan_input,
        r.legacy_plan_cached_input_tokens as plan_cached,
        r.legacy_plan_output_tokens as plan_output,
        r.legacy_plan_cost_micros as plan_cost,
        r.legacy_api_key_input_tokens as api_input,
        r.legacy_api_key_cached_input_tokens as api_cached,
        r.legacy_api_key_output_tokens as api_output,
        r.legacy_api_key_cost_micros as api_cost
      from runs r
      where r.id in (${sql.join(
        runIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    ),
    turns as (
      select rt.run_id, rt.codex_thread_id, rt.codex_turn_id, rt.started_at, p.completed_at
      from run_turns rt join picked p on p.id = rt.run_id
      union
      select p.id, p.codex_thread_id, p.codex_turn_id, coalesce(p.started_at, p.created_at),
        p.completed_at
      from picked p
      where p.codex_turn_id is not null
        and not exists (select 1 from run_turns rt
          where rt.codex_thread_id = p.codex_thread_id and rt.codex_turn_id = p.codex_turn_id)
    ),
    sums as (
      select t.run_id, count(*) as requests,
        sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)) as tokens,
        sum(m.cost_micros) as cost_micros,
        bool_or(m.usage_estimated) as estimated
      from turns t join model_requests m on ${requestOfTurn("t", "t", "m")}
      where m.counts_usage
      group by t.run_id
    )
    select p.id, s.requests, s.tokens, s.cost_micros, s.estimated, p.plan_input, p.plan_cached, p.plan_output,
      p.plan_cost, p.api_input, p.api_cached, p.api_output, p.api_cost
    from picked p left join sums s on s.run_id = p.id`);
  const usage = new Map<string, RunUsage>();
  for (const row of result.rows) {
    const total = runUsage({
      legacy: {
        plan: legacyMode(row.plan_input, row.plan_cached, row.plan_output, row.plan_cost),
        api_key: legacyMode(row.api_input, row.api_cached, row.api_output, row.api_cost),
      },
      fromLogs: Number(row.requests ?? 0)
        ? {
            tokens: Number(row.tokens ?? 0),
            costMicros: Number(row.cost_micros ?? 0),
            estimated: row.estimated === true,
          }
        : null,
    });
    if (total) usage.set(row.id, total);
  }
  return usage;
}

type TeammateRow = {
  teammate_id: string | null;
  runs: number;
  input_tokens: string | number;
  cached_input_tokens: string | number;
  output_tokens: string | number;
};

/**
 * Tokens per teammate since `since`, and how many runs used them: counted model requests, and the
 * legacy totals of runs and of runs deleted since (`legacy_deleted_run_usage`). A request's
 * teammate is its run's, else the one the proxy recorded (a run deleted since). Runs are counted
 * once each, by id; a request whose run was deleted since it was logged can't name it any more,
 * and counts by its turn.
 */
export async function monthlyUsage(since: Date): Promise<UsageView[]> {
  const at = since.toISOString();
  const result = await db.execute<TeammateRow>(sql`
    with logged as (
      select coalesce(q.bot_id, m.teammate_id) as teammate_id, -- vocabulary: allow
        coalesce(q.run_id::text, m.codex_thread_id || ':' || coalesce(m.codex_turn_id, q.turn))
          as run_key,
        coalesce(m.input_tokens, 0) as input_tokens,
        coalesce(m.cached_input_tokens, 0) as cached_input_tokens,
        coalesce(m.output_tokens, 0) as output_tokens
      from model_requests m
      left join lateral (
        select rt.run_id, r.bot_id, rt.codex_turn_id as turn -- vocabulary: allow
        from run_turns rt join runs r on r.id = rt.run_id
        where rt.codex_thread_id = m.codex_thread_id
          and rt.codex_turn_id = coalesce(m.codex_turn_id, ${unturnedTurnSql("m")})
        limit 1
      ) q on true
      where m.source = 'codex' and m.counts_usage and m.started_at >= ${at}::timestamptz
    ),
    legacy as (
      select r.bot_id as teammate_id, r.id::text as run_key, -- vocabulary: allow
        coalesce(r.legacy_plan_input_tokens, 0) + coalesce(r.legacy_api_key_input_tokens, 0)
          as input_tokens,
        coalesce(r.legacy_plan_cached_input_tokens, 0)
          + coalesce(r.legacy_api_key_cached_input_tokens, 0) as cached_input_tokens,
        coalesce(r.legacy_plan_output_tokens, 0) + coalesce(r.legacy_api_key_output_tokens, 0)
          as output_tokens
      from runs r
      where r.legacy_usage_at >= ${at}::timestamptz
    ),
    deleted as (
      select (select b.id from bots b where b.id = d.teammate_id) as teammate_id, -- vocabulary: allow
        coalesce(d.run_id::text, d.source_key) as run_key,
        d.input_tokens, d.cached_input_tokens, d.output_tokens
      from legacy_deleted_run_usage d
      where d.at >= ${at}::timestamptz
    ),
    everything as (
      select * from logged union all select * from legacy union all select * from deleted
    )
    select teammate_id, count(distinct run_key)::int as runs,
      sum(input_tokens) as input_tokens,
      sum(cached_input_tokens) as cached_input_tokens,
      sum(output_tokens) as output_tokens
    from everything
    group by teammate_id
    order by sum(input_tokens + output_tokens) desc, teammate_id`);
  return result.rows.map((row) => ({
    teammateId: row.teammate_id,
    runs: Number(row.runs),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens),
  }));
}
