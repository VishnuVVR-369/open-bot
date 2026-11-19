// Browsing model logs: the runs list's filters and its keyset cursor, text search, and the
// highlighted snippet a search hit shows. Pure, so the web app's queries and views share it.
import { z } from "zod";

/**
 * How much of each response text, and of each blob's decoded text, is searched. The search indexes
 * cover this prefix (`model_requests_response_search_idx` and `model_blobs_search_idx`, through
 * `model_blob_search_text`, in `packages/db/src/schema/model-logs.ts`), which keeps every document
 * well under Postgres's 1 MB `tsvector` limit.
 */
export const MODEL_LOG_SEARCH_CHARS = 100_000;

/** The longest search the runs list takes. */
export const MODEL_LOG_SEARCH_MAX = 200;

/** A run's status, as the runs list filters it; `errors` is any run with a failed request. */
export const RUN_LOG_STATUSES = ["done", "failed", "stopped", "working", "errors"] as const;
export const runLogStatusSchema = z.enum(RUN_LOG_STATUSES);
export type RunLogStatus = (typeof RUN_LOG_STATUSES)[number];

/** The `runs.status` values each filter stands for; `errors` filters on requests instead. */
export function runStatusesFor(filter: Exclude<RunLogStatus, "errors">): string[] {
  switch (filter) {
    case "done":
      return ["completed"];
    case "failed":
      return ["failed"];
    case "stopped":
      return ["interrupted"];
    case "working":
      return ["queued", "starting", "running", "waiting"];
  }
}

/**
 * The words to search for, or null when there are none: trimmed, spaces collapsed and cut to
 * `MODEL_LOG_SEARCH_MAX`. The query reads them with `websearch_to_tsquery`, so quotes and `-`
 * work as they do in a web search, and nothing typed can break the query.
 */
export function searchTerms(text: string | null | undefined): string | null {
  const terms = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MODEL_LOG_SEARCH_MAX);
  return terms === "" ? null : terms;
}

/* ------------------------------------------------------------------ Keyset cursor */

/**
 * A newest-first page's cursor: the last row's time to the microsecond in UTC (Postgres keeps
 * microseconds, a JavaScript date only milliseconds, so the time is read as text with
 * `to_char(... at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), then `_` and its id, which
 * breaks ties between rows of the same microsecond.
 */
export const KEYSET_CURSOR =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * Whether a text is a cursor these lists make, at a time that exists: a month that exists, a day
 * it has, a time of day. Postgres refuses the others, so they never reach it.
 */
export function isKeysetCursor(text: string): boolean {
  const match = KEYSET_CURSOR.exec(text);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    year >= 1 &&
    days !== undefined &&
    day >= 1 &&
    day <= days &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

/** The SQL that reads a time column as a cursor's exact time. */
export const EXACT_TIME_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** The cursor after a row, from its exact time and id. */
export function keysetCursor(exactTime: string, id: string): string {
  return `${exactTime}_${id}`;
}

/** A cursor's time and id, or null when it isn't one these lists make. */
export function parseKeysetCursor(
  text: string | null | undefined,
): { at: string; id: string } | null {
  if (!text || !isKeysetCursor(text)) return null;
  const at = text.slice(0, text.indexOf("_"));
  return { at, id: text.slice(at.length + 1) };
}

/* ------------------------------------------------------------------ Search snippets */

/** What `ts_headline` puts around a hit; neither can appear in stored text as typed. */
export const HIT_START = "\u0002";
export const HIT_END = "\u0003";

/** A snippet's parts, each a hit or not, ready to render as text. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(HIT_START);
    if (start < 0) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), hit: false });
    const end = rest.indexOf(HIT_END, start + 1);
    const hit = rest.slice(start + 1, end < 0 ? undefined : end);
    if (hit) parts.push({ text: hit, hit: true });
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  // Stray markers are never shown.
  return parts
    .map((part) => ({ ...part, text: part.text.replaceAll(HIT_START, "").replaceAll(HIT_END, "") }))
    .filter((part) => part.text !== "");
}

/** At most this many words, and this many characters, are kept before a snippet's first hit. */
export const SNIPPET_LEAD_WORDS = 4;
export const SNIPPET_LEAD_CHARS = 32;

/**
 * A snippet on one line, with only a few words before its first hit and "…" for what was cut, so
 * the hit stays in view however few lines the list shows of it.
 */
export function trimSnippetLead(snippet: string): string {
  const text = snippet.replace(/\s+/g, " ").trim();
  const start = text.indexOf(HIT_START);
  if (start <= 0) return text;
  const lead = text.slice(0, start);
  const words = lead.trimEnd().split(" ");
  let kept: string[] = [];
  for (let i = words.length - 1; i >= 0 && kept.length < SNIPPET_LEAD_WORDS; i--) {
    const next = [words[i]!, ...kept];
    if (next.join(" ").length > SNIPPET_LEAD_CHARS) break;
    kept = next;
  }
  if (kept.length === words.length) return text;
  const gap = lead.endsWith(" ") ? " " : "";
  return `…${kept.length ? ` ${kept.join(" ")}` : ""}${gap}${text.slice(start)}`;
}
