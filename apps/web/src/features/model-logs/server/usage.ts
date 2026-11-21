import "server-only";
import type { ModelLogUsage } from "@open-bot/api";
import { ownerSettings } from "@open-bot/db";
import {
  bucketFor,
  EMPTY_USAGE,
  fillBuckets,
  monthStart,
  planWindowHeaders,
  planWindowStep,
  type UsageNumbers,
} from "@open-bot/domain";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { requestFailedSql, unturnedTurnSql } from "./attribution";

/**
 * The Usage tab, read from `model_requests`: every request once, with its tokens, cost and
 * whether it failed, its teammate by the run it belongs to (`unturnedTurnSql` places a request
 * that names no turn, as everywhere else) or as the proxy recorded it, and the plan's windows from its rate-limit headers.
 */

type NumbersRow = {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_micros: number;
  errors: number;
};

const NUMBERS = sql`count(*)::int as requests,
  coalesce(sum(input_tokens), 0)::float8 as input_tokens,
  coalesce(sum(cached_input_tokens), 0)::float8 as cached_input_tokens,
  coalesce(sum(output_tokens), 0)::float8 as output_tokens,
  coalesce(sum(reasoning_tokens), 0)::float8 as reasoning_tokens,
  coalesce(sum(cost_micros), 0)::float8 as cost_micros,
  (count(*) filter (where failed))::int as errors`;

function numbers(row: NumbersRow): UsageNumbers {
  return {
    requests: Number(row.requests),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    costMicros: Number(row.cost_micros),
    errors: Number(row.errors),
  };
}

/**
 * The range's requests, each with its teammate by its run, else as the proxy recorded it (a run
 * deleted with its chat), else none (the memory AI's), and its day in the owner's time zone.
 */
export function usageRequestsSql(input: { from: string; to: string }, timeZone: string): SQL {
  return sql`
    select m.id, m.model, m.input_tokens, m.cached_input_tokens, m.output_tokens,
      m.reasoning_tokens, m.cost_micros, ${requestFailedSql("m")} as failed,
      (m.started_at at time zone ${timeZone})::date as day,
      coalesce(
        (select r.teammate_id from run_turns rt join runs r on r.id = rt.run_id
          where rt.codex_thread_id = m.codex_thread_id
            and rt.codex_turn_id = coalesce(m.codex_turn_id, ${unturnedTurnSql("m")})
          limit 1),
        m.teammate_id) as teammate_id
    from model_requests m
    where m.started_at >= ${input.from}::timestamptz and m.started_at < ${input.to}::timestamptz`;
}

/** A day as `YYYY-MM-DD` in a time zone. */
function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

/** Tokens, cost and errors over the range, per teammate and model, and the plan's windows. */
export async function getModelLogUsage(input: {
  from: string;
  to: string;
}): Promise<ModelLogUsage> {
  const settings = await ownerSettings(db);
  const timeZone = settings?.timezone ?? "UTC";
  const from = new Date(input.from);
  const to = new Date(input.to);
  const bucket = bucketFor(from, to);
  const requests = usageRequestsSql(input, timeZone);
  const bucketOf = bucket === "week" ? sql`date_trunc('week', day)::date` : sql`day`;
  const step = planWindowStep(from, to);
  // Each hour's highest reading, or each day's, from midnight in the owner's zone.
  const readingAt =
    step === "hour"
      ? sql`date_trunc('hour', m.started_at)`
      : sql`date_trunc('day', m.started_at at time zone ${timeZone}) at time zone ${timeZone}`;
  const primary = planWindowHeaders("primary");
  const secondary = planWindowHeaders("secondary");
  const percent = (name: string) =>
    sql`case when m.rate_limit_headers->>${name} ~ '^[0-9]+(\\.[0-9]+)?$'
      then least(100, (m.rate_limit_headers->>${name})::float8) end`;
  const month = monthStart();

  const [series, teammates, models, windows, minutes, spend] = await Promise.all([
    db.execute<NumbersRow & { bucket: string }>(sql`
      select to_char(${bucketOf}, 'YYYY-MM-DD') as bucket, ${NUMBERS}
      from (${requests}) q group by 1 order by 1`),
    db.execute<NumbersRow & { teammate_id: string | null; name: string | null }>(sql`
      select q.teammate_id, t.name, ${NUMBERS}
      from (${requests}) q left join teammates t on t.id = q.teammate_id
      group by q.teammate_id, t.name
      order by sum(coalesce(q.input_tokens, 0) + coalesce(q.output_tokens, 0)) desc`),
    db.execute<NumbersRow & { model: string | null }>(sql`
      select model, ${NUMBERS}
      from (${requests}) q group by model
      order by sum(coalesce(q.input_tokens, 0) + coalesce(q.output_tokens, 0)) desc`),
    db.execute<{ at: Date; primary: number | null; secondary: number | null }>(sql`
      select ${readingAt} as at,
        max(${percent(primary.usedPercent)}) as primary,
        max(${percent(secondary.usedPercent)}) as secondary
      from model_requests m
      where m.route = 'plan' and m.rate_limit_headers is not null
        and m.started_at >= ${input.from}::timestamptz and m.started_at < ${input.to}::timestamptz
        and (m.rate_limit_headers ? ${primary.usedPercent}
          or m.rate_limit_headers ? ${secondary.usedPercent})
      group by 1 order by 1`),
    db.execute<{ primary: string | null; secondary: string | null }>(sql`
      select m.rate_limit_headers->>${primary.windowMinutes} as primary,
        m.rate_limit_headers->>${secondary.windowMinutes} as secondary
      from model_requests m
      where m.route = 'plan' and m.rate_limit_headers ? ${primary.usedPercent}
        and m.started_at < ${input.to}::timestamptz
      order by m.started_at desc limit 1`),
    db.execute<{ spend: number }>(sql`
      select coalesce(sum(cost_micros), 0)::float8 as spend from model_requests
      where route = 'api' and started_at >= ${month.toISOString()}::timestamptz`),
  ]);
  const minutesOf = (text: string | null | undefined) => {
    const value = Number(text);
    return text && Number.isFinite(value) && value > 0 ? value : null;
  };
  const filled = fillBuckets(
    series.rows.map((row) => ({ bucket: row.bucket, ...numbers(row) })),
    dayIn(from, timeZone),
    dayIn(new Date(to.getTime() - 1), timeZone),
    bucket,
    (day) => ({ bucket: day, ...EMPTY_USAGE }),
  );
  const totals = filled.reduce<UsageNumbers>(
    (sum, row) => {
      const next = { ...sum };
      for (const key of Object.keys(EMPTY_USAGE) as (keyof UsageNumbers)[]) next[key] += row[key];
      return next;
    },
    { ...EMPTY_USAGE },
  );
  return {
    timeZone,
    bucket,
    series: filled,
    totals,
    teammates: teammates.rows.map((row) => ({
      teammateId: row.teammate_id,
      name: row.name,
      ...numbers(row),
    })),
    models: models.rows.map((row) => ({ model: row.model, ...numbers(row) })),
    planWindows: {
      step,
      primaryMinutes: minutesOf(minutes.rows[0]?.primary),
      secondaryMinutes: minutesOf(minutes.rows[0]?.secondary),
      points: windows.rows.map((row) => ({
        at: new Date(row.at).toISOString(),
        primary: row.primary === null ? null : Number(row.primary),
        secondary: row.secondary === null ? null : Number(row.secondary),
      })),
    },
    apiKey: {
      monthStart: month.toISOString(),
      spendMicros: Number(spend.rows[0]?.spend ?? 0),
      capMicros: settings?.monthlyCapMicros ?? 0,
    },
  };
}
