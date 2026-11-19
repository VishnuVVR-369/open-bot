import "server-only";
import { UNTURNED_SLACK_MS } from "@open-bot/domain";
import { sql, type SQL } from "drizzle-orm";

// How model requests are attributed to runs, as SQL: the one rule the runs list, its filters, the
// inspector, the Tools and Usage tabs and the export all join by.

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
