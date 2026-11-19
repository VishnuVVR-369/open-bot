import "server-only";
import type { ModelLogFilterOptions, ModelLogRunFilters } from "@open-bot/api";
import { MODEL_LOG_SEARCH_CHARS, runStatusesFor, searchTerms } from "@open-bot/domain";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { requestFailedSql, requestOfTurn } from "./attribution";

/**
 * The runs list's filters and text search as SQL. Built here, apart from the query that runs
 * them, so each piece is tested on its own.
 */

const CHARS = sql.raw(String(MODEL_LOG_SEARCH_CHARS));

/** The search as a `tsquery`: `websearch_to_tsquery`, so nothing typed can break it. */
export function searchQuerySql(terms: string): SQL {
  return sql`websearch_to_tsquery('simple', ${terms})`;
}

/**
 * Requests whose response text, any item they sent or got back, their instructions or their tool
 * definitions match the search: `request_id` and, for a blob, the blob it matched in. A blob is
 * searched by its decoded string values (`blobSearchTextSql`), so a word after a newline is a word.
 * Blobs are matched once, through their GIN index, and then followed to whatever names them; the
 * expressions must stay exactly those of `model_requests_response_search_idx` and
 * `model_blobs_search_idx`.
 */
export function searchHitsSql(terms: string): SQL {
  const query = searchQuerySql(terms);
  return sql`
    select m.id as request_id, null::text as blob_hash
    from model_requests m
    where to_tsvector('simple', left(coalesce(m.response_text, ''), ${CHARS})) @@ ${query}
    union all
    select named.request_id, b.hash as blob_hash
    from model_blobs b
    cross join lateral (
      select i.request_id from model_request_items i where i.blob_hash = b.hash
      union all
      select m.id from model_requests m where m.instructions_hash = b.hash
      union all
      select m.id from model_requests m where m.tools_hash = b.hash
    ) named
    where to_tsvector('simple', ${blobSearchTextSql("b")}) @@ ${query}`;
}

/**
 * What search reads of a blob (alias `alias`): its JSON string values decoded, without keys or
 * structural values, the first 100,000 characters of them (`model_blob_search_text`, created by
 * migration 0039). The search, the snippet and `model_blobs_search_idx` all read exactly this.
 */
export function blobSearchTextSql(alias: string): SQL {
  return sql`model_blob_search_text(${sql.raw(alias)}.content)`;
}

/** Whether the run (alias `r`) has a request that `condition` (on alias `m`) holds for. */
function anyRequest(condition: SQL): SQL {
  return sql`exists (
    select 1 from run_turns frt
    join model_requests m on ${requestOfTurn("frt", "r", "m")}
    where frt.run_id = r.id and ${condition})`;
}

/**
 * The filters as one condition on the run, alias `r`. Requests are attributed to runs the way the
 * inspector does (`requestOfTurn`), so a filter on requests matches the requests the run shows.
 * Text search is applied apart, through `searchHitsSql`.
 */
export function runFiltersSql(filters: Omit<ModelLogRunFilters, "q">): SQL {
  const parts: SQL[] = [sql`true`];
  if (filters.teammateId) parts.push(sql`r.bot_id = ${filters.teammateId}::uuid`); // vocabulary: allow
  if (filters.chatId) parts.push(sql`r.chat_id = ${filters.chatId}::uuid`);
  if (filters.from) parts.push(sql`r.created_at >= ${filters.from}::timestamptz`);
  if (filters.to) parts.push(sql`r.created_at < ${filters.to}::timestamptz`);
  if (filters.access)
    parts.push(sql`exists (select 1 from run_turns art
      where art.run_id = r.id and art.access_mode = ${filters.access})`);
  if (filters.model) parts.push(anyRequest(sql`m.model = ${filters.model}`));
  if (filters.status === "errors") parts.push(anyRequest(requestFailedSql("m")));
  else if (filters.status)
    parts.push(
      sql`r.status in (${sql.join(
        runStatusesFor(filters.status).map((status) => sql`${status}`),
        sql`, `,
      )})`,
    );
  return sql.join(parts, sql` and `);
}

/** The search's words, or null; what `runFiltersSql`'s caller searches for. */
export const runSearchTerms = (filters: Pick<ModelLogRunFilters, "q">) => searchTerms(filters.q);

/**
 * The choices the filters offer: every teammate that has run with logs (former ones as "Former
 * teammate"), the 200 chats with the latest logged runs, and every model in the logs.
 */
export async function listFilterOptions(): Promise<ModelLogFilterOptions> {
  const [teammates, chats, models] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      select t.id, t.name from bots t -- vocabulary: allow
      where exists (select 1 from runs r join run_turns rt on rt.run_id = r.id
        where r.bot_id = t.id) -- vocabulary: allow
      order by lower(t.name)`),
    db.execute<{ id: string; title: string }>(sql`
      select c.id, c.title from chats c
      join (select r.chat_id, max(rt.started_at) as last
        from run_turns rt join runs r on r.id = rt.run_id group by r.chat_id) l on l.chat_id = c.id
      order by l.last desc
      limit 200`),
    // A loose index scan over `model_requests_model_idx`: one probe per model, however many rows.
    db.execute<{ model: string }>(sql`
      with recursive models as (
        (select model from model_requests where model is not null order by model limit 1)
        union all
        select (select model from model_requests where model > models.model order by model limit 1)
        from models where models.model is not null
      )
      select model from models where model is not null`),
  ]);
  return {
    teammates: teammates.rows,
    chats: chats.rows.map((row) => ({ id: row.id, title: row.title || "Untitled chat" })),
    models: models.rows.map((row) => row.model),
  };
}
