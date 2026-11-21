import "server-only";
import { MODEL_LOG_RUNS_PAGE, type ModelLogRunFilters, type ModelLogRuns } from "@open-bot/api";
import {
  type AuthMode,
  EXACT_TIME_FORMAT,
  keysetCursor,
  MODEL_LOG_SEARCH_CHARS,
  parseKeysetCursor,
  type RunStatus,
  type RunTrigger,
  trimSnippetLead,
} from "@open-bot/domain";
import { type SQL, sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { requestFailedSql, requestOfTurn } from "./attribution";
import {
  blobSearchTextSql,
  runFiltersSql,
  runSearchTerms,
  searchHitsSql,
  searchQuerySql,
} from "./filters";

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
  access_modes: AuthMode[] | null;
  bodies_expired_at: Date | null;
  match: string | null;
};

/** How much text around a hit a search result shows. */
const SNIPPET_OPTIONS =
  "MaxFragments=1, MaxWords=22, MinWords=10, ShortWord=2, FragmentDelimiter=' … '";
/**
 * A snippet is cut from this much of the text around the first place a searched word appears
 * (from `SNIPPET_BEFORE` characters before it), so it costs the same wherever in the searchable
 * text the match is. Only when the whole search doesn't match that window (the word was found
 * inside another one, or a phrase or another word is further on) is the whole text read.
 */
const SNIPPET_WINDOW = 4_000;
const SNIPPET_BEFORE = 1_000;

/**
 * Runs with model logs (a turn or a Codex message), newest first, a page at a time, each with its
 * requests' tokens, cost and errors, narrowed by the filters and, with words to find, by Postgres
 * full-text search over what the run's requests sent and got back. Pages are cut by creation time
 * and id together, at full precision, so runs created in the same microsecond are never skipped.
 */
export async function listModelLogRuns(
  input: ModelLogRunFilters & { before?: string },
): Promise<ModelLogRuns> {
  const cursor = parseKeysetCursor(input.before);
  const terms = runSearchTerms(input);
  const query = terms ? searchQuerySql(terms) : sql`null::tsquery`;
  const headline = (text: SQL) =>
    sql`ts_headline('simple', ${text}, ${query},
      'StartSel=' || chr(2) || ', StopSel=' || chr(3) || ', ' || ${SNIPPET_OPTIONS})`;
  // With words to find, only runs with a matching request, and for each run its first hit.
  const hits = terms
    ? sql`hits as (${searchHitsSql(terms)}),
      run_hits as (
        select distinct on (rt.run_id) rt.run_id, h.request_id, h.blob_hash
        from hits h
        join model_requests m on m.id = h.request_id
        join run_turns rt on rt.codex_thread_id = m.codex_thread_id
        join runs hr on hr.id = rt.run_id and ${requestOfTurn("rt", "hr", "m")}
        order by rt.run_id, m.started_at, h.blob_hash nulls first
      ),`
    : sql`run_hits as (select null::uuid as run_id, null::uuid as request_id, null::text as blob_hash where false),`;
  const { rows } = await db.execute<RunRow>(sql`
    with ${hits}
    page as (
      select r.id, r.teammate_id, r.chat_id, r.trigger, r.status, r.created_at, r.completed_at
      from runs r
      where (exists (select 1 from run_turns rt where rt.run_id = r.id)
          or exists (select 1 from codex_events e where e.run_id = r.id))
        and ${runFiltersSql(input)}
        and (${terms === null}::boolean or r.id in (select run_id from run_hits))
        and (${cursor?.at ?? null}::timestamptz is null
          or (r.created_at, r.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      order by r.created_at desc, r.id desc
      limit ${MODEL_LOG_RUNS_PAGE + 1}
    ),
    linked as (
      select distinct p.id as run_id, m.id, m.input_tokens, m.cached_input_tokens,
        m.output_tokens, m.cost_micros, m.bodies_expired_at, ${requestFailedSql("m")} as failed
      from page p
      join run_turns rt on rt.run_id = p.id
      join model_requests m on ${requestOfTurn("rt", "p", "m")}
    )
    select p.id as run_id, p.teammate_id, t.name as teammate_name,
      p.chat_id, c.title as chat_title, p.trigger, p.status, p.created_at,
      to_char(p.created_at at time zone 'UTC', ${EXACT_TIME_FORMAT}) as created_at_exact,
      count(l.id)::int as requests,
      coalesce(sum(l.input_tokens), 0)::float8 as input_tokens,
      coalesce(sum(l.cached_input_tokens), 0)::float8 as cached_input_tokens,
      coalesce(sum(l.output_tokens), 0)::float8 as output_tokens,
      coalesce(sum(l.cost_micros), 0)::float8 as cost_micros,
      (count(l.id) filter (where l.failed))::int as errors,
      min(l.bodies_expired_at) as bodies_expired_at,
      (select array_agg(distinct rt.access_mode order by rt.access_mode)
        from run_turns rt where rt.run_id = p.id) as access_modes,
      (select case when to_tsvector('simple', near.text) @@ ${query}
          then ${headline(sql`near.text`)}
          else ${headline(sql`src.text`)} end
        from run_hits rh
        cross join lateral (
          select case when rh.blob_hash is null
            then (select left(m.response_text, ${MODEL_LOG_SEARCH_CHARS}) from model_requests m
              where m.id = rh.request_id)
            -- A blob's text as search read it: its string values decoded, no JSON around them.
            else (select ${blobSearchTextSql("b")} from model_blobs b where b.hash = rh.blob_hash)
            end as text) src
        -- Where the first searched word (one the search doesn't exclude) appears.
        cross join lateral (
          select coalesce(min(nullif(strpos(lower(src.text), w[1]), 0)), 1) as at
          from regexp_matches(querytree(${query})::text, '(?<!!)''([^'']+)''', 'g') w
        ) found
        -- The text around it, used only when the whole search matches it.
        cross join lateral (
          select substr(src.text, greatest(1, found.at - ${SNIPPET_BEFORE}), ${SNIPPET_WINDOW}) as text
        ) near
        where rh.run_id = p.id) as match
    from page p
    join chats c on c.id = p.chat_id
    left join teammates t on t.id = p.teammate_id
    left join linked l on l.run_id = p.id
    group by p.id, p.teammate_id, t.name, p.chat_id, c.title, p.trigger, p.status, p.created_at
    order by p.created_at desc, p.id desc
  `);
  const page = rows.slice(0, MODEL_LOG_RUNS_PAGE);
  const last = page[page.length - 1];
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
      accessModes: row.access_modes ?? [],
      bodiesExpiredAt: row.bodies_expired_at ? new Date(row.bodies_expired_at).toISOString() : null,
      match: row.match === null ? null : trimSnippetLead(row.match),
    })),
    nextBefore:
      rows.length > MODEL_LOG_RUNS_PAGE && last
        ? keysetCursor(last.created_at_exact, last.run_id)
        : null,
  };
}
