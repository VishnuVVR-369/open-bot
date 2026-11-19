import "server-only";
import type { CodexEventSummary, ModelRequestBodies } from "@open-bot/api";
import {
  type CodexEventDirection,
  type CodexEventKind,
  describeItem,
  instructionsText,
  offeredTools,
  rebuildInput,
} from "@open-bot/domain";
import { sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { ApiError } from "@/lib/server/api/errors";

type RequestRow = {
  id: string;
  params: Record<string, unknown> | null;
  request_headers: Record<string, string>;
  response_headers: Record<string, string> | null;
  sent_input_from: number | null;
  response_text: string | null;
  reasoning_summary: string | null;
  raw_response: string | null;
  instructions: string | null;
  tools: string | null;
};

type ItemRow = { side: "input" | "output"; position: number; content: string | null };

/**
 * One request's bodies, read when it is opened: the input rebuilt in order from its stored items,
 * the instructions, the tools, and the response.
 */
export async function getModelRequestBodies(requestId: string): Promise<ModelRequestBodies> {
  const [request, items] = await Promise.all([
    db.execute<RequestRow>(sql`
      select m.id, m.params, m.request_headers, m.response_headers, m.sent_input_from,
        m.response_text, m.reasoning_summary, m.raw_response,
        ib.content as instructions, tb.content as tools
      from model_requests m
      left join model_blobs ib on ib.hash = m.instructions_hash
      left join model_blobs tb on tb.hash = m.tools_hash
      where m.id = ${requestId}`),
    db.execute<ItemRow>(sql`
      select i.side, i.position, b.content
      from model_request_items i
      left join model_blobs b on b.hash = i.blob_hash
      where i.request_id = ${requestId}
      order by i.side, i.position`),
  ]);
  const row = request.rows[0];
  if (!row) throw new ApiError("NOT_FOUND", "That request is gone.");
  const input = rebuildInput(
    items.rows.filter((item) => item.side === "input"),
    row.sent_input_from,
  );
  const output = items.rows
    .filter((item) => item.side === "output")
    .map((item) => {
      let parsed: unknown = item.content;
      try {
        parsed = item.content === null ? null : JSON.parse(item.content);
      } catch {
        // Kept as text below.
      }
      return { position: item.position, ...describeItem(parsed), json: item.content };
    });
  return {
    id: row.id,
    input: input.items,
    missingInput: input.missing,
    instructions: instructionsText(row.instructions),
    tools: offeredTools(row.tools),
    output,
    responseText: row.response_text || null,
    reasoningSummary: row.reasoning_summary || null,
    rawResponse: row.raw_response,
    params: row.params ? JSON.stringify(row.params, null, 2) : null,
    requestHeaders: row.request_headers ?? {},
    responseHeaders: row.response_headers,
  };
}

type EventRow = {
  id: string;
  at: Date;
  direction: CodexEventDirection;
  kind: CodexEventKind;
  method: string;
  item_id: string | null;
  codex_turn_id: string | null;
  size: number | null;
  omitted: string | null;
  delta_counts: Record<string, Record<string, number>> | null;
};

/** A run's Codex messages in wire order, without their payloads. */
export async function listRunEvents(runId: string): Promise<CodexEventSummary[]> {
  const { rows } = await db.execute<EventRow>(sql`
    select id, at, direction, kind, method, item_id, codex_turn_id, delta_counts,
      payload->>'omitted' as omitted,
      (case when payload->>'size' ~ '^[0-9]+$' and payload ? 'omitted'
        then (payload->>'size')::float8
        else coalesce(octet_length(payload::text), 0) end)::float8 as size
    from codex_events where run_id = ${runId}
    order by sequence`);
  return rows.map((row) => ({
    id: row.id,
    at: new Date(row.at).toISOString(),
    direction: row.direction,
    kind: row.kind,
    method: row.method,
    itemId: row.item_id,
    turnId: row.codex_turn_id,
    size: Number(row.size ?? 0),
    omitted: row.omitted,
    deltaCounts: row.delta_counts,
  }));
}

/** One Codex message's payload, laid out as JSON. */
export async function getRunEvent(eventId: string): Promise<{ payload: string }> {
  const { rows } = await db.execute<{ payload: unknown }>(
    sql`select payload from codex_events where id = ${eventId}`,
  );
  if (!rows[0]) throw new ApiError("NOT_FOUND", "That message is gone.");
  return { payload: JSON.stringify(rows[0].payload ?? null, null, 2) };
}
