import "server-only";
import { MODEL_LOG_RUNS_PAGE, type ModelLogRuns } from "@open-bot/api";
import type { RunStatus, RunTrigger } from "@open-bot/domain";
import { UNTURNED_SLACK_MS } from "@open-bot/domain";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/server/db";

const slack = sql.raw(`make_interval(secs => ${UNTURNED_SLACK_MS / 1000})`);

/**
 * The turn a request that names none (a prewarm) belongs to, out of every turn of its thread, from
 * any run: the latest turn that had started when the request was sent, if that turn's run was
 * still going; else the next turn, if it started within `UNTURNED_SLACK_MS` after the request
 * (Codex can send a prewarm before `turn/start` returns and the turn is saved). Null when
 * neither. Each request gets at most one turn, so it counts toward at most one run. Takes the
 * alias of `model_requests` in the query.
 */
export function unturnedTurnSql(request: string): SQL {
  const m = sql.raw(request);
  return sql`coalesce(
    (select latest.codex_turn_id from (
        select ut.codex_turn_id, ur.completed_at
        from run_turns ut join runs ur on ur.id = ut.run_id
        where ut.codex_thread_id = ${m}.codex_thread_id and ut.started_at <= ${m}.started_at
        order by ut.started_at desc, ut.codex_turn_id desc
        limit 1
      ) latest
      where latest.completed_at is null or latest.completed_at >= ${m}.started_at),
    (select ut.codex_turn_id
      from run_turns ut
      where ut.codex_thread_id = ${m}.codex_thread_id
        and ut.started_at > ${m}.started_at
        and ut.started_at <= ${m}.started_at + ${slack}
      order by ut.started_at, ut.codex_turn_id
      limit 1))`;
}

/**
 * Model requests belong to a run through its turns (`run_turns`): by thread and turn, or, for a
 * request that names no turn, by the turn `unturnedTurnSql` places it in. The list's totals and
 * the inspector both join this way. Takes the aliases of `run_turns`, of the turn's run (`runs`,
 * or a row with its `completed_at`) and of `model_requests`.
 *
 * The time bounds first narrow a request without a turn to the only ones the placement can give
 * the turn, so it is worked out for a few requests, not for every later one on a long thread:
 * placed in a turn that had started, it was sent before the turn's run ended; placed in the next
 * turn, before that turn started, and at most `UNTURNED_SLACK_MS` before.
 */
export function requestOfTurn(turn: string, run: string, request: string): SQL {
  const [t, r, m] = [sql.raw(turn), sql.raw(run), sql.raw(request)];
  return sql`${m}.codex_thread_id = ${t}.codex_thread_id and (
    ${m}.codex_turn_id = ${t}.codex_turn_id
    or (${m}.codex_turn_id is null
      and ${m}.started_at >= ${t}.started_at - ${slack}
      and ${m}.started_at <= greatest(coalesce(${r}.completed_at, 'infinity'), ${t}.started_at)
      and ${unturnedTurnSql(request)} = ${t}.codex_turn_id))`;
}

/** Whether a request failed, as `requestFailed` in `@open-bot/domain` says. */
export function requestFailedSql(request: string): SQL {
  const m = sql.raw(request);
  return sql`(${m}.status is null or ${m}.status >= 400 or ${m}.error_type is not null or ${m}.error_message is not null)`;
}

type RunRow = {
  run_id: string;
  teammate_id: string | null;
  teammate_name: string | null;
  chat_id: string;
  chat_title: string;
  trigger: RunTrigger;
  status: RunStatus;
  created_at: Date;
  /** `created_at` to the microsecond, in UTC, for the next page's cursor. */
  created_at_exact: string;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  errors: number;
};

/**
 * Runs with model logs (a turn or a Codex message), newest first, a page at a time, each with its
 * requests' tokens, cost and errors. Pages are cut by creation time and id together, at full
 * precision, so runs created in the same microsecond are never skipped.
 */
export async function listModelLogRuns({ before }: { before?: string }): Promise<ModelLogRuns> {
  const cursor = before ? parseRunsCursor(before) : null;
  const { rows } = await db.execute<RunRow>(sql`
    with page as (
      select r.id, r.bot_id, r.chat_id, r.trigger, r.status, r.created_at, r.completed_at -- vocabulary: allow
      from runs r
      where (exists (select 1 from run_turns rt where rt.run_id = r.id)
          or exists (select 1 from codex_events e where e.run_id = r.id))
        and (${cursor?.at ?? null}::timestamptz is null
          or (r.created_at, r.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      order by r.created_at desc, r.id desc
      limit ${MODEL_LOG_RUNS_PAGE + 1}
    ),
    linked as (
      select distinct p.id as run_id, m.id, m.input_tokens, m.cached_input_tokens,
        m.output_tokens, m.cost_micros, ${requestFailedSql("m")} as failed
      from page p
      join run_turns rt on rt.run_id = p.id
      join model_requests m on ${requestOfTurn("rt", "p", "m")}
    )
    select p.id as run_id, p.bot_id as teammate_id, t.name as teammate_name, -- vocabulary: allow
      p.chat_id, c.title as chat_title, p.trigger, p.status, p.created_at,
      to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_exact,
      count(l.id)::int as requests,
      coalesce(sum(l.input_tokens), 0)::float8 as input_tokens,
      coalesce(sum(l.cached_input_tokens), 0)::float8 as cached_input_tokens,
      coalesce(sum(l.output_tokens), 0)::float8 as output_tokens,
      coalesce(sum(l.cost_micros), 0)::float8 as cost_micros,
      (count(l.id) filter (where l.failed))::int as errors
    from page p
    join chats c on c.id = p.chat_id
    left join bots t on t.id = p.bot_id -- vocabulary: allow
    left join linked l on l.run_id = p.id
    group by p.id, p.bot_id, t.name, p.chat_id, c.title, p.trigger, p.status, p.created_at -- vocabulary: allow
    order by p.created_at desc, p.id desc
  `);
  const page = rows.slice(0, MODEL_LOG_RUNS_PAGE);
  return {
    runs: page.map((row) => ({
      runId: row.run_id,
      teammateId: row.teammate_id,
      teammateName: row.teammate_name,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      trigger: row.trigger,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
      costMicros: Number(row.cost_micros),
      errors: Number(row.errors),
    })),
    nextBefore: rows.length > MODEL_LOG_RUNS_PAGE ? runsCursor(page[page.length - 1]!) : null,
  };
}

/** Where the next page starts: after this run, by its exact creation time and then its id. */
function runsCursor(row: RunRow): string {
  return `${row.created_at_exact}_${row.run_id}`;
}

function parseRunsCursor(cursor: string): { at: string; id: string } {
  const [at, id] = cursor.split("_") as [string, string];
  return { at, id };
}
