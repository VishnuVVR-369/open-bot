import "server-only";
import { EXACT_TIME_FORMAT, exportLine, type ExportedRequestRow } from "@open-bot/domain";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { requestOfTurn, unturnedTurnSql } from "./attribution";

/**
 * The JSONL export: every request of one run, or of a date range, rebuilt in full, one JSON object
 * per line (`exportLine` in `@open-bot/domain`), oldest first. It is read a few requests at a
 * time and each request's bodies on their own, so a run of any length never sits in memory whole;
 * unlike the inspector, nothing is capped.
 */

export type ExportScope = { runId: string } | { from?: string; to?: string };

/** Requests read per query. Their bodies are read one request at a time. */
export const EXPORT_BATCH = 25;

type Row = {
  id: string;
  run_id: string | null;
  source: string;
  route: string | null;
  transport: string;
  method: string;
  endpoint: string;
  teammate_id: string | null;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  request_kind: string | null;
  model: string | null;
  response_id: string | null;
  status: number | null;
  started_at: Date;
  started_exact: string;
  first_byte_at: Date | null;
  ended_at: Date | null;
  input_tokens: string | null;
  cached_input_tokens: string | null;
  output_tokens: string | null;
  reasoning_tokens: string | null;
  cost_micros: string;
  usage_estimated: boolean;
  stop_reason: string | null;
  error_type: string | null;
  error_message: string | null;
  request_headers: Record<string, string>;
  response_headers: Record<string, string> | null;
  rate_limit_headers: Record<string, string> | null;
  params: Record<string, unknown> | null;
  sent_input_from: number | null;
  response_text: string | null;
  reasoning_summary: string | null;
  raw_response: string | null;
  parse_warnings: string[];
  bodies_expired_at: Date | null;
};

const iso = (value: Date | null) => (value === null ? null : new Date(value).toISOString());
const num = (value: string | null) => (value === null ? null : Number(value));

/** Which requests the scope holds, as a condition on `m`, and the run each belongs to. */
function scopeSql(scope: ExportScope): { where: SQL; runId: SQL } {
  if ("runId" in scope)
    return {
      where: sql`m.id in (select m2.id from run_turns rt
        join runs r2 on r2.id = rt.run_id
        join model_requests m2 on ${requestOfTurn("rt", "r2", "m2")}
        where rt.run_id = ${scope.runId}::uuid)`,
      runId: sql`${scope.runId}::uuid`,
    };
  const parts: SQL[] = [sql`true`];
  if (scope.from) parts.push(sql`m.started_at >= ${scope.from}::timestamptz`);
  if (scope.to) parts.push(sql`m.started_at < ${scope.to}::timestamptz`);
  return {
    where: sql.join(parts, sql` and `),
    runId: sql`(select rt.run_id from run_turns rt
      where rt.codex_thread_id = m.codex_thread_id
        and rt.codex_turn_id = coalesce(m.codex_turn_id, ${unturnedTurnSql("m")})
      limit 1)`,
  };
}

/**
 * The export's lines, each ending in a newline. `onBatch` hears each page of requests read, so a
 * test can see the export reads as it goes rather than all at once.
 */
export async function* exportRequests(
  scope: ExportScope,
  onBatch?: (requests: number) => void,
): AsyncGenerator<string> {
  const { where, runId } = scopeSql(scope);
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const result: { rows: Row[] } = await db.execute<Row>(sql`
      select m.id, ${runId} as run_id, m.source, m.route, m.transport, m.method, m.endpoint,
        m.teammate_id, m.codex_thread_id, m.codex_turn_id, m.request_kind, m.model,
        m.response_id, m.status, m.started_at,
        to_char(m.started_at at time zone 'UTC', ${EXACT_TIME_FORMAT}) as started_exact,
        m.first_byte_at, m.ended_at, m.input_tokens, m.cached_input_tokens, m.output_tokens,
        m.reasoning_tokens, m.cost_micros, m.usage_estimated, m.stop_reason, m.error_type, m.error_message,
        m.request_headers, m.response_headers, m.rate_limit_headers, m.params,
        m.sent_input_from, m.response_text, m.reasoning_summary, m.raw_response,
        m.parse_warnings, m.bodies_expired_at
      from model_requests m
      where ${where}
        and (${after?.at ?? null}::timestamptz is null
          or (m.started_at, m.id) > (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid))
      order by m.started_at, m.id
      limit ${EXPORT_BATCH}`);
    const rows = result.rows;
    onBatch?.(rows.length);
    for (const row of rows) yield `${await lineOf(row)}\n`;
    if (rows.length < EXPORT_BATCH) return;
    const last: Row = rows[rows.length - 1]!;
    after = { at: last.started_exact, id: last.id };
  }
}

/** One request rebuilt: its bodies read now, on their own. */
async function lineOf(row: Row): Promise<string> {
  const [items, blobs, calls] = await Promise.all([
    db.execute<{ side: "input" | "output"; position: number; content: string | null }>(sql`
      select i.side, i.position, b.content
      from model_request_items i
      left join model_blobs b on b.hash = i.blob_hash
      where i.request_id = ${row.id}
      order by i.side, i.position`),
    db.execute<{ instructions: string | null; tools: string | null }>(sql`
      select ib.content as instructions, tb.content as tools
      from model_requests m
      left join model_blobs ib on ib.hash = m.instructions_hash
      left join model_blobs tb on tb.hash = m.tools_hash
      where m.id = ${row.id}`),
    db.execute<{ call_id: string | null; type: string; name: string; arguments: string | null }>(
      sql`select call_id, type, name, arguments from model_tool_calls
        where request_id = ${row.id} order by position`,
    ),
  ]);
  // Positions with nothing stored come out as null, so every item keeps its place.
  const side = (which: "input" | "output") => {
    const rows = items.rows.filter((item) => item.side === which);
    const length = rows.length ? Math.max(...rows.map((item) => item.position)) + 1 : 0;
    const list: (string | null)[] = Array.from({ length }, () => null);
    for (const item of rows) list[item.position] = item.content;
    return list;
  };
  const exported: ExportedRequestRow = {
    id: row.id,
    runId: row.run_id,
    source: row.source,
    route: row.route,
    transport: row.transport,
    method: row.method,
    endpoint: row.endpoint,
    teammateId: row.teammate_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    requestKind: row.request_kind,
    model: row.model,
    responseId: row.response_id,
    status: row.status,
    startedAt: iso(row.started_at)!,
    firstByteAt: iso(row.first_byte_at),
    endedAt: iso(row.ended_at),
    inputTokens: num(row.input_tokens),
    cachedInputTokens: num(row.cached_input_tokens),
    outputTokens: num(row.output_tokens),
    reasoningTokens: num(row.reasoning_tokens),
    costMicros: Number(row.cost_micros),
    usageEstimated: row.usage_estimated,
    stopReason: row.stop_reason,
    errorType: row.error_type,
    errorMessage: row.error_message,
    requestHeaders: row.request_headers ?? {},
    responseHeaders: row.response_headers,
    rateLimitHeaders: row.rate_limit_headers,
    params: row.params,
    sentInputFrom: row.sent_input_from,
    responseText: row.response_text,
    reasoningSummary: row.reasoning_summary,
    rawResponse: row.raw_response,
    parseWarnings: row.parse_warnings ?? [],
    bodiesExpiredAt: iso(row.bodies_expired_at),
  };
  return exportLine(exported, {
    instructions: blobs.rows[0]?.instructions ?? null,
    tools: blobs.rows[0]?.tools ?? null,
    input: side("input"),
    output: side("output"),
    toolCalls: calls.rows.map((call) => ({
      callId: call.call_id,
      type: call.type,
      name: call.name,
      arguments: call.arguments,
    })),
  });
}

/**
 * The export as a byte stream that reads a request only when the reader asks for more. `onBatch`
 * is `exportRequests`'s.
 */
export function exportStream(
  scope: ExportScope,
  onBatch?: (requests: number) => void,
): ReadableStream<Uint8Array> {
  const lines = exportRequests(scope, onBatch);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await lines.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await lines.return(undefined);
      },
    },
    // Nothing read ahead: the next request is read when the reader takes the last one.
    { highWaterMark: 0 },
  );
}

/** The download's name: the run's short id, or the range's days. */
export function exportFileName(scope: ExportScope): string {
  if ("runId" in scope) return `model-logs-run-${scope.runId.slice(0, 8)}.jsonl`;
  const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : null);
  const from = day(scope.from);
  const to = day(scope.to);
  if (from && to) return `model-logs-${from}-to-${to}.jsonl`;
  if (from) return `model-logs-from-${from}.jsonl`;
  if (to) return `model-logs-to-${to}.jsonl`;
  return "model-logs.jsonl";
}
