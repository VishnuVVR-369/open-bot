// How long model logs keep their bodies. The owner picks a number of days, or forever; a daily
// sweep in the worker removes what is older, and keeps every number, status, tool name and link.
import { z } from "zod";

/** The choices Settings offers, in days. Null, forever, is the default. */
export const MODEL_LOG_RETENTION_CHOICES = [7, 14, 30, 60, 90, 180, 365] as const;

/** The longest a window can be: ten years. */
export const MODEL_LOG_RETENTION_MAX_DAYS = 3650;

export const modelLogRetentionSchema = z
  .number()
  .int("Pick a whole number of days.")
  .min(1, "Keep bodies for at least a day.")
  .max(MODEL_LOG_RETENTION_MAX_DAYS, "Keep bodies for at most ten years.")
  .nullable();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The moment before which bodies expire: `days` whole days before `now`, or null when they are
 * kept forever (no window, or one that isn't a positive whole number).
 */
export function retentionCutoff(now: Date, days: number | null | undefined): Date | null {
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || days < 1) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

/** Whether something logged at `at` has expired by `now`. */
export function hasExpired(at: Date, now: Date, days: number | null | undefined): boolean {
  const cutoff = retentionCutoff(now, days);
  return cutoff !== null && at.getTime() < cutoff.getTime();
}

/** A window in words: "Forever", "1 year", "6 months", "90 days", "1 week". */
export function retentionLabel(days: number | null): string {
  if (days === null) return "Forever";
  if (days === 365) return "1 year";
  if (days === 180) return "6 months";
  if (days === 7) return "1 week";
  if (days === 14) return "2 weeks";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The fields of a Codex item an expired message keeps: what it was, how it ended and the tool it
 * named, never what it was given or gave back. `error` is kept cut to `EXPIRED_ERROR_CHARS`.
 */
export const EXPIRED_ITEM_FIELDS = [
  "type",
  "id",
  "status",
  "exitCode",
  "durationMs",
  "success",
  "server",
  "tool",
  "namespace",
] as const;

/** How much of an item's error an expired message keeps. */
export const EXPIRED_ERROR_CHARS = 300;

/**
 * The request parameters an expired request keeps: how it was asked (model, effort, limits,
 * flags), never what it said. Anything else, such as a scalar `input`, `messages`, `prompt`,
 * `metadata` or a JSON schema, goes. This lists what stays, so a field nobody thought of is
 * removed rather than kept.
 */
export const EXPIRED_PARAM_FIELDS = [
  "model",
  "stream",
  "store",
  "background",
  "parallel_tool_calls",
  "service_tier",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens",
  "max_tool_calls",
  "temperature",
  "top_p",
  "top_logprobs",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "n",
  "truncation",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning_effort",
  "verbosity",
  "dimensions",
  "encoding_format",
  "tool_choice",
] as const;

/** Object parameters an expired request keeps, each with the fields of it that stay. */
export const EXPIRED_PARAM_OBJECTS: Readonly<Record<string, readonly string[]>> = {
  reasoning: ["effort", "summary", "generate_summary"],
  text: ["verbosity"],
  tool_choice: ["type", "name", "mode"],
  stream_options: ["include_usage", "include_obfuscation"],
};

/** List parameters an expired request keeps, with only their string elements. */
export const EXPIRED_PARAM_LISTS = ["include"] as const;

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A request's parameters once its bodies expired: only the fields `EXPIRED_PARAM_FIELDS`,
 * `EXPIRED_PARAM_OBJECTS` and `EXPIRED_PARAM_LISTS` name, with plain values. The retention
 * sweep stores this, and the inspector and export show it for any expired request.
 */
export function expiredParams(params: unknown): Record<string, unknown> | null {
  if (!isRecord(params)) return null;
  const kept: Record<string, unknown> = {};
  const scalars: readonly string[] = EXPIRED_PARAM_FIELDS;
  const lists: readonly string[] = EXPIRED_PARAM_LISTS;
  for (const [key, value] of Object.entries(params)) {
    if (scalars.includes(key) && isScalar(value)) kept[key] = value;
    else if (Object.hasOwn(EXPIRED_PARAM_OBJECTS, key) && isRecord(value)) {
      const fields = EXPIRED_PARAM_OBJECTS[key] ?? [];
      const object = Object.fromEntries(
        Object.entries(value).filter(([field, inner]) => fields.includes(field) && isScalar(inner)),
      );
      if (Object.keys(object).length) kept[key] = object;
    } else if (lists.includes(key) && Array.isArray(value))
      kept[key] = value.filter((item): item is string => typeof item === "string");
  }
  return kept;
}
