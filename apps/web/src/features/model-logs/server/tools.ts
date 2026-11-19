import "server-only";
import type { Clipped } from "@open-bot/api";
import {
  codeModeCells,
  runTools,
  TOOL_ITEM_TYPES,
  type ToolCallRow,
  type ToolCallView,
  type ToolItemRow,
} from "@open-bot/domain";
import { type SQL, sql } from "drizzle-orm";
import { db } from "@/lib/server/db";

/** How much of a tool call's arguments, or of what it got back, the run view carries. */
const ARGUMENTS_CHARS = 4_000;
const RETURNED_CHARS = 2_000;
/** How much of a tool item's output the run view carries; its full message is in the events. */
const OUTPUT_CHARS = 4_000;

const TOOL_TYPES = [...TOOL_ITEM_TYPES];

const date = (value: Date | string) => new Date(value);

/** The start of a text, with how long it is in full. */
function clipped(text: string | null, chars: number | null): Clipped | null {
  return text === null ? null : { text, chars: Number(chars ?? text.length) };
}

type CallRow = {
  request_id: string;
  position: number;
  call_id: string | null;
  type: string;
  name: string;
  namespace: string | null;
  arguments: string | null;
  arguments_chars: number | null;
};

type OutputRow = { request_id: string; call_id: string; text: string | null };

type ItemEventRow = {
  method: string;
  item_id: string;
  codex_thread_id: string | null;
  at: Date;
  type: string | null;
  omitted: string | null;
  item: Record<string, unknown> | null;
  output: string | null;
  output_chars: number | null;
};

/** A request as the tool join needs it. */
export interface ToolRequest {
  id: string;
  threadId: string | null;
  startedAt: Date;
  firstByteAt: Date | null;
}

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * What each tool call got back: the tool output items the requests' input carried, each from the
 * first request of its thread that carried it, cut short. Every request repeats the items before
 * it, so the history is first cut down to where each item of a thread first appeared; only then
 * is each distinct output item parsed, once, and its text cut. Nothing done per item grows with
 * how often later requests repeated it.
 */
export function firstToolOutputsSql(requestIds: string[]): SQL {
  return sql`
    with firsts as materialized (
      select distinct on (m.codex_thread_id, i.blob_hash)
        i.blob_hash, m.codex_thread_id as thread_id, m.started_at, i.request_id
      from model_request_items i
      join model_requests m on m.id = i.request_id
      where i.request_id in (${idList(requestIds)}) and i.side = 'input'
      order by m.codex_thread_id, i.blob_hash, m.started_at, i.request_id
    ),
    parsed as materialized (
      select b.hash, b.content::jsonb as j
      from model_blobs b
      where b.hash in (select blob_hash from firsts)
        and b.kind = 'item'
        and b.content like '%call_output%'
    ),
    outputs as materialized (
      select p.hash, p.j->>'call_id' as call_id,
        left(coalesce(
          case when jsonb_typeof(p.j->'output') = 'string' then p.j->>'output' end,
          jsonb_path_query_first(p.j, '$.output[*] ? (exists(@.text)).text') #>> '{}'
        ), ${RETURNED_CHARS + 1}) as text
      from parsed p
      where p.j->>'type' in ('function_call_output', 'custom_tool_call_output')
        and p.j->>'call_id' is not null
    )
    select distinct on (f.thread_id, o.call_id) f.request_id, o.call_id, o.text
    from firsts f
    join outputs o on o.hash = f.blob_hash
    order by f.thread_id, o.call_id, f.started_at, f.request_id`;
}

export async function firstToolOutputs(requestIds: string[]): Promise<OutputRow[]> {
  if (!requestIds.length) return [];
  return (await db.execute<OutputRow>(firstToolOutputsSql(requestIds))).rows;
}

/**
 * Where a run's requests stop, when the inspector lists only its first ones: when the first one
 * left out started, and the first one left out in each thread. Those carry what the last listed
 * calls got back, and when their code-mode cells ended; their own calls aren't read.
 */
export interface RequestsCut {
  at: Date;
  next: ToolRequest[];
}

/**
 * The tool calls of the listed requests joined to their outcomes. Reads only what the join needs:
 * each request's calls with their arguments cut short, what each call got back
 * (`firstToolOutputs`), and the run's tool items without their large fields. When the requests
 * stop short of the run's end (`cut`), items that started after it are read only if they can
 * belong to a listed call: one of its own items, whenever it was reported, or an item started
 * while one of its code-mode cells was known to run. An item that started before the cut is read
 * whole, its completion included.
 */
export async function toolsOf(runId: string, requests: ToolRequest[], cut: RequestsCut | null) {
  const ids = requests.map((r) => r.id);
  const linked = [...requests, ...(cut?.next ?? [])];
  const [calls, outputs] = await Promise.all([
    ids.length
      ? db.execute<CallRow>(sql`
          select request_id, position, call_id, type, name, namespace,
            left(arguments, ${ARGUMENTS_CHARS}) as arguments, length(arguments) as arguments_chars
          from model_tool_calls where request_id in (${idList(ids)})`)
      : { rows: [] as CallRow[] },
    firstToolOutputs(linked.map((r) => r.id)),
  ]);

  const outputsByRequest = new Map<string, { callId: string; text: string }[]>();
  for (const row of outputs) {
    const list = outputsByRequest.get(row.request_id) ?? [];
    list.push({ callId: row.call_id, text: row.text ?? "" });
    outputsByRequest.set(row.request_id, list);
  }
  const callRows = calls.rows.map((row): ToolCallRow => ({
    requestId: row.request_id,
    position: row.position,
    callId: row.call_id,
    type: row.type,
    name: row.name,
    namespace: row.namespace,
    arguments: row.arguments,
  }));
  const linkRequests = linked.map((r) => ({ ...r, outputs: outputsByRequest.get(r.id) ?? [] }));
  const items = toolItems((await itemEvents(runId, linkRequests, callRows, cut)).rows);
  const view = runTools(linkRequests, callRows, items);

  const argumentChars = new Map(
    calls.rows.map((row) => [`${row.request_id}\u0000${row.position}`, row.arguments_chars]),
  );
  const toolCallView = (call: ToolCallView) => ({
    position: call.position,
    callId: call.callId,
    type: call.type,
    name: call.name,
    namespace: call.namespace,
    arguments: clipped(
      call.arguments,
      argumentChars.get(`${call.requestId}\u0000${call.position}`) ?? null,
    ),
    outcome: call.outcome,
    returned: call.returned ? clip(call.returned.text, RETURNED_CHARS) : null,
    nested: call.nested,
  });
  // An item that started after the cut and that no listed call explains belongs to a request
  // that isn't listed.
  const late = new Set(
    cut ? items.filter((item) => item.at >= cut.at).map((item) => item.itemId) : [],
  );
  return {
    calls: new Map([...view.calls].map(([id, list]) => [id, list.map(toolCallView)])),
    unlinked: view.unlinked.filter((outcome) => !late.has(outcome.itemId)),
  };
}

/**
 * The run's tool item messages (`item/started`, `item/completed`) without their large fields. With
 * a cut, only those of items that started before it, of the listed calls' own items, and of
 * items that started while a listed code-mode cell was known to run (up to when the last one
 * ended), so nothing a listed call made loses its outcome.
 */
function itemEvents(
  runId: string,
  requests: (ToolRequest & { outputs: { callId: string; text: string }[] })[],
  calls: ToolCallRow[],
  cut: RequestsCut | null,
) {
  let until: string | null = null;
  let own = sql`false`;
  if (cut) {
    let horizon = cut.at.getTime();
    const callsOf = Map.groupBy(calls, (c) => c.requestId);
    const byThread = Map.groupBy(
      requests.map((r) => ({ ...r, calls: callsOf.get(r.id) ?? [] })),
      (r) => r.threadId,
    );
    for (const threadRequests of byThread.values())
      for (const cell of codeModeCells(threadRequests))
        if (cell.until) horizon = Math.max(horizon, cell.until.getTime());
    until = new Date(horizon).toISOString();
    const listed = [...new Set(calls.map((c) => c.requestId))];
    if (listed.length)
      own = sql`exists (
        select 1 from model_tool_calls c
        join model_requests m on m.id = c.request_id
        where c.request_id in (${idList(listed)})
          and c.call_id = e.item_id and m.codex_thread_id = e.codex_thread_id)`;
  }
  return db.execute<ItemEventRow>(sql`
    select e.method, e.item_id, e.codex_thread_id, e.at,
      e.payload->'item'->>'type' as type,
      e.payload->>'omitted' as omitted,
      (e.payload->'item')
        - array['aggregatedOutput', 'result', 'contentItems', 'changes', 'output', 'arguments']
        || jsonb_build_object('paths',
          coalesce(jsonb_path_query_array(e.payload->'item', '$.changes[*].path'), '[]'::jsonb))
        as item,
      left(o.text, ${OUTPUT_CHARS}) as output,
      length(o.text) as output_chars
    from codex_events e
    cross join lateral (select coalesce(
      e.payload->'item'->>'aggregatedOutput',
      (select string_agg(t #>> '{}', E'\\n')
        from jsonb_path_query(e.payload->'item', '$.result.content[*].text') t),
      (select string_agg(t #>> '{}', E'\\n')
        from jsonb_path_query(e.payload->'item', '$.contentItems[*].text') t),
      (select string_agg(t #>> '{}', E'\\n')
        from jsonb_path_query(e.payload->'item', '$.changes[*].diff') t),
      e.payload->'item'->>'output'
    ) as text) o
    where e.run_id = ${runId}
      and e.method in ('item/started', 'item/completed')
      and e.item_id is not null
      and (e.payload->'item'->>'type' in (${sql.join(
        TOOL_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )}) or e.payload ? 'omitted')
      and (${until}::timestamptz is null
        or e.at < ${until}::timestamptz
        or ${own}
        or exists (
          select 1 from codex_events s
          where s.run_id = e.run_id and s.codex_thread_id = e.codex_thread_id
            and s.item_id = e.item_id and s.at < ${until}::timestamptz))
    order by e.sequence`);
}

function clip(text: string, max: number): Clipped {
  return { text: text.length > max ? text.slice(0, max) : text, chars: text.length };
}

/** A run's tool items, from their started and completed messages, in the order they started. */
function toolItems(rows: ItemEventRow[]): ToolItemRow[] {
  const byItem = new Map<string, ToolItemRow>();
  for (const row of rows) {
    if (!row.codex_thread_id) continue;
    const key = `${row.codex_thread_id}\u0000${row.item_id}`;
    const seen = byItem.get(key);
    const completed = row.method === "item/completed";
    if (!seen) {
      if (!row.type && !row.omitted) continue;
      byItem.set(key, {
        itemId: row.item_id,
        threadId: row.codex_thread_id,
        type: row.type ?? "unknown",
        at: date(row.at),
        completed,
        item: row.item,
        output: row.output,
        outputChars: Number(row.output_chars ?? 0),
        omitted: completed ? row.omitted : null,
      });
      continue;
    }
    if (!completed) continue;
    // The completed item has the outcome; the started one, the time and, if this was cut, the type.
    seen.completed = !row.omitted;
    seen.omitted = row.omitted;
    if (row.type) seen.type = row.type;
    if (row.item) seen.item = row.item;
    if (!row.omitted) {
      seen.output = row.output;
      seen.outputChars = Number(row.output_chars ?? 0);
    }
  }
  return [...byItem.values()].filter((row) => TOOL_ITEM_TYPES.has(row.type));
}
