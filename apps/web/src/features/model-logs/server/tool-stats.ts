import "server-only";
import { TOOL_FAILURES_PAGE, type ToolFailures, type ToolStat } from "@open-bot/api";
import {
  EXACT_TIME_FORMAT,
  keysetCursor,
  outcomeOf,
  parseKeysetCursor,
  TOOL_ERROR_STATUSES,
  TOOL_ITEM_TYPES,
  TOOL_KIND_NAMES,
} from "@open-bot/domain";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { requestOfTurn } from "./attribution";
import { toolsOf } from "./tools";

/**
 * The Tools tab: every tool item Codex completed (`item/completed` in `codex_events`), named and
 * judged the way `toolNameOf` and `toolItemFailed` in `@open-bot/domain` do, across runs.
 */

/** How much of a failure's input and output the list carries. */
const IO_CHARS = 4_000;

const list = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** A tool item's name, as `toolNameOf` gives it. Takes SQL for the item type and the item. */
export function toolNameSql(type: SQL, item: SQL): SQL {
  const kinds = Object.entries(TOOL_KIND_NAMES).map(
    ([kind, name]) => sql`when ${kind} then ${name}`,
  );
  return sql`(case ${type}
    when 'dynamicToolCall' then coalesce(nullif(concat_ws('.', nullif(${item}->>'namespace', ''),
      nullif(${item}->>'tool', '')), ''), 'open-bot tool')
    when 'mcpToolCall' then coalesce(nullif(concat_ws('.', nullif(${item}->>'server', ''),
      nullif(${item}->>'tool', '')), ''), 'MCP tool')
    when 'collabAgentToolCall' then coalesce(nullif(${item}->>'tool', ''), 'Agent tool')
    ${sql.join(kinds, sql` `)}
    else ${type} end)`;
}

/** Whether a completed tool item failed, as `toolItemFailed` says. Takes SQL for the item. */
export function toolFailedSql(item: SQL): SQL {
  return sql`coalesce(
    jsonb_typeof(${item}->'error') = 'object'
    or (jsonb_typeof(${item}->'error') = 'string' and ${item}->>'error' <> '')
    or ${item}->'success' = 'false'::jsonb
    or (jsonb_typeof(${item}->'exitCode') = 'number' and (${item}->>'exitCode')::numeric <> 0)
    or ${item}->>'status' in (${list(TOOL_ERROR_STATUSES)}), false)`;
}

/** The range and teammate the Tools tab reads, as conditions on `e` (the message) and `r` (its run). */
export function toolRangeSql(input: { from?: string; to?: string; teammateId?: string }): SQL {
  const parts: SQL[] = [sql`e.method = 'item/completed'`, sql`e.item_id is not null`];
  if (input.from) parts.push(sql`e.at >= ${input.from}::timestamptz`);
  if (input.to) parts.push(sql`e.at < ${input.to}::timestamptz`);
  if (input.teammateId) parts.push(sql`r.teammate_id = ${input.teammateId}::uuid`);
  return sql.join(parts, sql` and `);
}

/**
 * Each completed tool item in range: its type and item (from the completed message, or the
 * started one when the completed one was too large to keep), its name, whether it failed, and how
 * long it took (`durationMs`, else from started to completed).
 */
function completedItems(input: { from?: string; to?: string; teammateId?: string }): SQL {
  const item = sql`x.item`;
  return sql`
    select x.*, ${toolNameSql(sql`x.type`, item)} as name,
      (not x.omitted and ${toolFailedSql(item)}) as failed
    from (
      select e.id, e.run_id, e.codex_thread_id, e.item_id, e.at, e.bodies_expired_at,
        r.teammate_id, r.chat_id,
        e.payload ? 'omitted' as omitted,
        coalesce(e.payload->'item', s.item) as item,
        coalesce(e.payload->'item'->>'type', s.item->>'type') as type,
        coalesce(
          case when jsonb_typeof(e.payload->'item'->'durationMs') = 'number'
            then (e.payload->'item'->>'durationMs')::float8 end,
          extract(epoch from (e.at - s.at)) * 1000) as duration_ms
      from codex_events e
      left join runs r on r.id = e.run_id
      left join lateral (
        select st.at, st.payload->'item' as item from codex_events st
        where st.codex_thread_id = e.codex_thread_id and st.item_id = e.item_id
          and st.method = 'item/started'
        order by st.sequence limit 1
      ) s on true
      where ${toolRangeSql(input)}
    ) x
    where x.type in (${list([...TOOL_ITEM_TYPES])})`;
}

type StatRow = {
  name: string;
  type: string;
  calls: number;
  failed: number;
  unknown: number;
  median_ms: number | null;
  p95_ms: number | null;
  teammates: number;
};

/** Each tool's calls, failures and duration over the range, most used first. */
export async function listToolStats(input: {
  from?: string;
  to?: string;
  teammateId?: string;
}): Promise<ToolStat[]> {
  const { rows } = await db.execute<StatRow>(sql`
    select name, type, count(*)::int as calls,
      (count(*) filter (where failed))::int as failed,
      (count(*) filter (where omitted))::int as unknown,
      percentile_cont(0.5) within group (order by duration_ms) as median_ms,
      percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
      count(distinct teammate_id)::int as teammates
    from (${completedItems(input)}) t
    group by name, type
    order by count(*) desc, name`);
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    calls: Number(row.calls),
    failed: Number(row.failed),
    unknown: Number(row.unknown),
    medianMs: row.median_ms === null ? null : Math.round(Number(row.median_ms)),
    p95Ms: row.p95_ms === null ? null : Math.round(Number(row.p95_ms)),
    teammates: Number(row.teammates),
  }));
}

type FailureRow = {
  id: string;
  run_id: string;
  codex_thread_id: string;
  item_id: string;
  at: Date;
  at_exact: string;
  name: string;
  type: string;
  item: Record<string, unknown>;
  teammate_id: string | null;
  teammate_name: string | null;
  chat_title: string;
  bodies_expired_at: Date | null;
  input: string | null;
  input_chars: number | null;
  output: string | null;
  output_chars: number | null;
};

/** A request of a run, as the tool join needs it. */
type RunRequestRow = {
  id: string;
  codex_thread_id: string | null;
  started_at: Date;
  first_byte_at: Date | null;
};

/**
 * Every failed tool item over the range, newest first, a page at a time, with what it was given
 * and gave back, and how it is tied to the model's call: exactly by the call's id, by time for an
 * item a code-mode cell made, or not at all (the same join as the run inspector).
 */
export async function listToolFailures(input: {
  from?: string;
  to?: string;
  teammateId?: string;
  tool?: string;
  before?: string;
}): Promise<ToolFailures> {
  const cursor = parseKeysetCursor(input.before);
  const { rows } = await db.execute<FailureRow>(sql`
    select f.id, f.run_id, f.codex_thread_id, f.item_id, f.at, f.name, f.type,
      to_char(f.at at time zone 'UTC', ${EXACT_TIME_FORMAT}) as at_exact,
      f.item - array['aggregatedOutput', 'result', 'contentItems', 'changes', 'output', 'arguments',
        'command', 'query'] as item,
      f.teammate_id, t.name as teammate_name, coalesce(c.title, '') as chat_title,
      f.bodies_expired_at,
      left(io.input, ${IO_CHARS}) as input, length(io.input) as input_chars,
      left(io.output, ${IO_CHARS}) as output, length(io.output) as output_chars
    from (${completedItems(input)}) f
    left join teammates t on t.id = f.teammate_id
    left join chats c on c.id = f.chat_id
    cross join lateral (select
      coalesce(
        f.item->>'command',
        case when jsonb_typeof(f.item->'arguments') = 'string' then f.item->>'arguments'
          when f.item->'arguments' is not null then jsonb_pretty(f.item->'arguments') end,
        f.item->>'query',
        (select string_agg(concat_ws(E'\\n', ch->>'path', ch->>'diff'), E'\\n\\n')
          from jsonb_array_elements(case when jsonb_typeof(f.item->'changes') = 'array'
            then f.item->'changes' else '[]'::jsonb end) ch),
        f.item->>'path') as input,
      coalesce(
        f.item->>'aggregatedOutput',
        (select string_agg(v #>> '{}', E'\\n')
          from jsonb_path_query(f.item, '$.result.content[*].text') v),
        (select string_agg(v #>> '{}', E'\\n')
          from jsonb_path_query(f.item, '$.contentItems[*].text') v),
        case when jsonb_typeof(f.item->'output') = 'string' then f.item->>'output' end) as output
    ) io
    where f.failed and f.run_id is not null
      and (${input.tool ?? null}::text is null or f.name = ${input.tool ?? null}::text)
      and (${cursor?.at ?? null}::timestamptz is null
        or (f.at, f.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
    order by f.at desc, f.id desc
    limit ${TOOL_FAILURES_PAGE + 1}`);
  const page = rows.slice(0, TOOL_FAILURES_PAGE);
  const links = await linksOf(page);
  const last = page[page.length - 1];
  return {
    failures: page.map((row) => {
      const outcome = outcomeOf({
        itemId: row.item_id,
        threadId: row.codex_thread_id,
        type: row.type,
        at: new Date(row.at),
        completed: true,
        item: row.item,
        output: null,
        outputChars: 0,
        omitted: null,
      });
      const link = links.get(`${row.codex_thread_id}\u0000${row.item_id}`);
      return {
        eventId: row.id,
        runId: row.run_id,
        itemId: row.item_id,
        at: new Date(row.at).toISOString(),
        name: row.name,
        type: row.type,
        // The command or query is the input below; the title is the tool.
        title: row.name,
        status: outcome.status,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        teammateId: row.teammate_id,
        teammateName: row.teammate_name,
        chatTitle: row.chat_title,
        input: row.input === null ? null : { text: row.input, chars: Number(row.input_chars) },
        output: row.output === null ? null : { text: row.output, chars: Number(row.output_chars) },
        error: outcome.error,
        link: link?.match ?? "none",
        candidates: link?.candidates ?? 0,
        callName: link?.callName ?? null,
        callArguments: link?.callArguments ?? null,
        bodiesExpiredAt: row.bodies_expired_at
          ? new Date(row.bodies_expired_at).toISOString()
          : null,
      };
    }),
    nextBefore:
      rows.length > TOOL_FAILURES_PAGE && last ? keysetCursor(last.at_exact, last.id) : null,
  };
}

type Link = {
  match: "exact" | "only_candidate" | "ambiguous";
  candidates: number;
  callName: string;
  callArguments: { text: string; chars: number } | null;
};

/**
 * How each failed item is tied to a model call, by the run inspector's join (`toolsOf`) over the
 * runs on the page: the call whose id it has, or the code-mode cells running when it started.
 */
async function linksOf(rows: FailureRow[]): Promise<Map<string, Link>> {
  const links = new Map<string, Link>();
  const runIds = [...new Set(rows.map((row) => row.run_id))];
  for (const runId of runIds) {
    const { rows: requests } = await db.execute<RunRequestRow>(sql`
      select distinct m.id, m.codex_thread_id, m.started_at, m.first_byte_at
      from run_turns rt
      join runs r on r.id = rt.run_id
      join model_requests m on ${requestOfTurn("rt", "r", "m")}
      where rt.run_id = ${runId}`);
    const tools = await toolsOf(
      runId,
      requests.map((r) => ({
        id: r.id,
        threadId: r.codex_thread_id,
        startedAt: new Date(r.started_at),
        firstByteAt: r.first_byte_at ? new Date(r.first_byte_at) : null,
      })),
      null,
    );
    const threadOf = new Map(requests.map((r) => [r.id, r.codex_thread_id]));
    for (const [requestId, calls] of tools.calls) {
      const thread = threadOf.get(requestId);
      for (const call of calls) {
        const name = call.namespace ? `${call.namespace}.${call.name}` : call.name;
        if (call.outcome)
          links.set(`${thread}\u0000${call.outcome.itemId}`, {
            match: "exact",
            candidates: 1,
            callName: name,
            callArguments: call.arguments,
          });
        for (const nested of call.nested) {
          const key = `${thread}\u0000${nested.itemId}`;
          if (links.has(key)) continue;
          links.set(key, {
            match: nested.match,
            candidates: nested.candidates,
            callName: name,
            callArguments: call.arguments,
          });
        }
      }
    }
  }
  return links;
}
