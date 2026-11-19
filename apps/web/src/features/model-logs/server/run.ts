import "server-only";
import { MODEL_LOG_RUN_REQUESTS, type ModelRequestSummary, type RunModelLogs } from "@open-bot/api";
import {
  type AuthMode,
  placeRequests,
  requestFailed,
  retriesOf,
  type RunStatus,
  type RunTrigger,
} from "@open-bot/domain";
import { sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { ApiError } from "@/lib/server/api/errors";
import { requestFailedSql, requestOfTurn } from "./attribution";
import { toolsOf } from "./tools";

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
const date = (value: Date | string) => new Date(value);
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

type RunRow = {
  id: string;
  teammate_id: string | null;
  teammate_name: string | null;
  chat_id: string;
  chat_title: string;
  prompt: string;
  trigger: RunTrigger;
  status: RunStatus;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type TurnRow = {
  codex_thread_id: string;
  codex_turn_id: string;
  access_mode: AuthMode;
  started_at: Date;
};

type RequestRow = {
  id: string;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  placed_turn_id: string;
  request_kind: string | null;
  model: string | null;
  route: string | null;
  transport: string;
  method: string;
  endpoint: string;
  status: number | null;
  started_at: Date;
  first_byte_at: Date | null;
  ended_at: Date | null;
  input_tokens: string | null;
  cached_input_tokens: string | null;
  output_tokens: string | null;
  reasoning_tokens: string | null;
  cost_micros: string;
  stop_reason: string | null;
  error_type: string | null;
  error_message: string | null;
  rate_limit_headers: Record<string, string> | null;
  parse_warnings: string[];
  sent_input_from: number | null;
  bodies_expired_at: Date | null;
  input_items: number;
  output_items: number;
};

type TotalsRow = {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  errors: number;
  bodies_expired_at: Date | null;
};

/**
 * One run's model logs: its turns, its requests in order with their tool calls, no bodies. A run
 * with more than `MODEL_LOG_RUN_REQUESTS` requests lists its first ones; its totals count them all.
 */
export async function getRunModelLogs(runId: string): Promise<RunModelLogs> {
  const run = (
    await db.execute<RunRow>(sql`
      select r.id, r.bot_id as teammate_id, t.name as teammate_name, r.chat_id, -- vocabulary: allow
        c.title as chat_title, r.prompt, r.trigger, r.status, r.error, r.created_at,
        r.started_at, r.completed_at
      from runs r
      join chats c on c.id = r.chat_id
      left join bots t on t.id = r.bot_id -- vocabulary: allow
      where r.id = ${runId}`)
  ).rows[0];
  if (!run) throw new ApiError("NOT_FOUND", "That run is gone.");

  const [turnRows, requestRows, totalsRows, eventCount] = await Promise.all([
    db.execute<TurnRow>(sql`
      select codex_thread_id, codex_turn_id, access_mode, started_at
      from run_turns where run_id = ${runId} order by started_at`),
    db.execute<RequestRow>(sql`
      with shown as (
        select m.*, rt.codex_turn_id as placed_turn_id
        from run_turns rt
        join runs r on r.id = rt.run_id
        join model_requests m on ${requestOfTurn("rt", "r", "m")}
        where rt.run_id = ${runId}
        order by m.started_at, m.id
        limit ${MODEL_LOG_RUN_REQUESTS + 1}
      )
      select m.id, m.codex_thread_id, m.codex_turn_id, m.placed_turn_id, m.request_kind, m.model,
        m.route, m.transport, m.method, m.endpoint, m.status, m.started_at, m.first_byte_at,
        m.ended_at, m.input_tokens, m.cached_input_tokens, m.output_tokens, m.reasoning_tokens,
        m.cost_micros, m.stop_reason, m.error_type, m.error_message, m.rate_limit_headers,
        m.parse_warnings, m.sent_input_from, m.bodies_expired_at,
        (select count(*) from model_request_items i
          where i.request_id = m.id and i.side = 'input')::int as input_items,
        (select count(*) from model_request_items i
          where i.request_id = m.id and i.side = 'output')::int as output_items
      from shown m
      order by m.started_at, m.id`),
    db.execute<TotalsRow>(sql`
      select count(*)::int as requests,
        coalesce(sum(m.input_tokens), 0)::float8 as input_tokens,
        coalesce(sum(m.cached_input_tokens), 0)::float8 as cached_input_tokens,
        coalesce(sum(m.output_tokens), 0)::float8 as output_tokens,
        coalesce(sum(m.cost_micros), 0)::float8 as cost_micros,
        (count(*) filter (where ${requestFailedSql("m")}))::int as errors,
        min(m.bodies_expired_at) as bodies_expired_at
      from run_turns rt
      join runs r on r.id = rt.run_id
      join model_requests m on ${requestOfTurn("rt", "r", "m")}
      where rt.run_id = ${runId}`),
    db.execute<{ count: number }>(
      sql`select count(*)::int as count from codex_events where run_id = ${runId}`,
    ),
  ]);
  // The first request left out, when there are more than the view lists.
  const cut = requestRows.rows[MODEL_LOG_RUN_REQUESTS];
  const shownRows = requestRows.rows.slice(0, MODEL_LOG_RUN_REQUESTS);
  const turns = turnRows.rows.map((row) => ({
    threadId: row.codex_thread_id,
    turnId: row.codex_turn_id,
    accessMode: row.access_mode,
    startedAt: date(row.started_at),
  }));
  const requests = shownRows.map((row) => ({
    ...row,
    threadId: row.codex_thread_id,
    turnId: row.codex_turn_id,
    placedTurnId: row.placed_turn_id,
    requestKind: row.request_kind,
    startedAt: date(row.started_at),
    status: row.status,
    errorType: row.error_type,
    errorMessage: row.error_message,
  }));
  const placed = placeRequests(turns, requests);
  const retries = retriesOf(placed);
  const tools = await toolsOf(
    runId,
    placed.map(({ request }) => ({
      id: request.id,
      threadId: request.threadId,
      startedAt: request.startedAt,
      firstByteAt: request.first_byte_at ? date(request.first_byte_at) : null,
    })),
    cut ? { at: date(cut.started_at), next: await firstLeftOut(runId, cut.id) } : null,
  );

  const summaries = placed.map(({ request: row, turn, match }) => ({
    turn,
    summary: {
      id: row.id,
      kind: row.request_kind,
      model: row.model,
      route: row.route,
      transport: row.transport,
      method: row.method,
      endpoint: row.endpoint,
      status: row.status,
      failed: requestFailed(row),
      startedAt: iso(row.started_at)!,
      firstByteAt: iso(row.first_byte_at),
      endedAt: iso(row.ended_at),
      inputTokens: num(row.input_tokens),
      cachedInputTokens: num(row.cached_input_tokens),
      outputTokens: num(row.output_tokens),
      reasoningTokens: num(row.reasoning_tokens),
      costMicros: Number(row.cost_micros),
      stopReason: row.stop_reason,
      errorType: row.error_type,
      errorMessage: row.error_message,
      rateLimits:
        row.rate_limit_headers && Object.keys(row.rate_limit_headers).length
          ? row.rate_limit_headers
          : null,
      parseWarnings: row.parse_warnings ?? [],
      inputItems: row.input_items,
      outputItems: row.output_items,
      sentInputFrom: row.sent_input_from,
      bodiesExpiredAt: iso(row.bodies_expired_at),
      turnMatch: match,
      retryOf: retries.get(row.id) ?? null,
      toolCalls: tools.calls.get(row.id) ?? [],
    } satisfies ModelRequestSummary,
  }));
  const totals = totalsRows.rows[0]!;
  return {
    run: {
      id: run.id,
      teammateId: run.teammate_id,
      teammateName: run.teammate_name,
      chatId: run.chat_id,
      chatTitle: run.chat_title,
      prompt: run.prompt.length > 600 ? `${run.prompt.slice(0, 600)}…` : run.prompt,
      trigger: run.trigger,
      status: run.status,
      error: run.error,
      createdAt: iso(run.created_at)!,
      startedAt: iso(run.started_at),
      completedAt: iso(run.completed_at),
    },
    totals: {
      requests: Number(totals.requests),
      inputTokens: Number(totals.input_tokens),
      cachedInputTokens: Number(totals.cached_input_tokens),
      outputTokens: Number(totals.output_tokens),
      costMicros: Number(totals.cost_micros),
      errors: Number(totals.errors),
    },
    shownRequests: summaries.length,
    turns: turnRows.rows.map((row, index) => ({
      threadId: row.codex_thread_id,
      turnId: row.codex_turn_id,
      accessMode: row.access_mode,
      startedAt: iso(row.started_at)!,
      requests: summaries.filter((s) => s.turn === index).map((s) => s.summary),
    })),
    unlinkedTools: tools.unlinked,
    events: eventCount.rows[0]?.count ?? 0,
    bodiesExpiredAt: iso(totals.bodies_expired_at),
  };
}

/**
 * The first request of each thread of the run from `cutId` on, the first one the inspector leaves
 * out: what the last listed calls of the thread got back is in its input.
 */
async function firstLeftOut(runId: string, cutId: string) {
  const { rows } = await db.execute<{
    id: string;
    codex_thread_id: string | null;
    started_at: Date;
    first_byte_at: Date | null;
  }>(sql`
    select distinct on (m.codex_thread_id) m.id, m.codex_thread_id, m.started_at, m.first_byte_at
    from run_turns rt
    join runs r on r.id = rt.run_id
    join model_requests m on ${requestOfTurn("rt", "r", "m")}
    where rt.run_id = ${runId}
      and (m.started_at, m.id) >= (select c.started_at, c.id from model_requests c where c.id = ${cutId})
    order by m.codex_thread_id, m.started_at, m.id`);
  return rows.map((row) => ({
    id: row.id,
    threadId: row.codex_thread_id,
    startedAt: date(row.started_at),
    firstByteAt: row.first_byte_at ? date(row.first_byte_at) : null,
  }));
}
