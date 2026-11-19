// Usage read from model logs: tokens, cache share, cost and errors over time, and the ChatGPT
// plan's usage windows from the rate-limit headers stored on each response.
import { z } from "zod";

/** How the usage chart groups requests: by day, or by week (Monday first) over long ranges. */
export const USAGE_BUCKETS = ["day", "week"] as const;
export const usageBucketSchema = z.enum(USAGE_BUCKETS);
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

/** Ranges longer than this many days are shown by week, so the chart keeps readable bars. */
export const DAILY_BUCKET_MAX_DAYS = 92;

/** The longest range the Usage tab reads at once, a bit over a year. */
export const USAGE_MAX_DAYS = 400;

/**
 * How the plan's windows are read: the highest reading each hour over a few days, and each
 * day's peak over longer ranges, where hourly readings would crowd into spikes.
 */
export const PLAN_WINDOW_STEPS = ["hour", "day"] as const;
export const planWindowStepSchema = z.enum(PLAN_WINDOW_STEPS);
export type PlanWindowStep = (typeof PLAN_WINDOW_STEPS)[number];

/** Ranges up to this many days show the plan's windows hour by hour. */
export const PLAN_HOURLY_MAX_DAYS = 3;

/** The step for the plan's windows over a range from `from` to `to`. */
export function planWindowStep(from: Date, to: Date): PlanWindowStep {
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  return days > PLAN_HOURLY_MAX_DAYS ? "day" : "hour";
}

/** The bucket for a range from `from` to `to`. */
export function bucketFor(from: Date, to: Date): UsageBucket {
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  return days > DAILY_BUCKET_MAX_DAYS ? "week" : "day";
}

/** Token counts and what they cost. */
export interface UsageNumbers {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costMicros: number;
  errors: number;
}

export const EMPTY_USAGE: UsageNumbers = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costMicros: 0,
  errors: 0,
};

/** Adds up usage numbers. */
export function sumUsage(rows: readonly UsageNumbers[]): UsageNumbers {
  const total = { ...EMPTY_USAGE };
  for (const row of rows)
    for (const key of Object.keys(total) as (keyof UsageNumbers)[]) total[key] += row[key];
  return total;
}

/**
 * The share of input tokens served from the prompt cache, from 0 to 1, or null with no input.
 * Cached tokens are counted inside input tokens, as the Responses API reports them.
 */
export function cacheShare(usage: Pick<UsageNumbers, "inputTokens" | "cachedInputTokens">) {
  if (usage.inputTokens <= 0) return null;
  return Math.min(1, Math.max(0, usage.cachedInputTokens / usage.inputTokens));
}

/** A calendar day as `YYYY-MM-DD`, moved by `days`. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week a day falls in, as Postgres's `date_trunc('week', ...)` gives it. */
export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(day, -offset);
}

/**
 * Every bucket from the one holding `fromDay` to the one holding `toDay`, in order, each with its
 * numbers from `rows` (keyed by the bucket's first day) or zeros, so a quiet day still shows.
 */
export function fillBuckets<T extends { bucket: string }>(
  rows: readonly T[],
  fromDay: string,
  toDay: string,
  bucket: UsageBucket,
  empty: (bucket: string) => T,
): T[] {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const step = bucket === "week" ? 7 : 1;
  const first = bucket === "week" ? weekOf(fromDay) : fromDay;
  const last = bucket === "week" ? weekOf(toDay) : toDay;
  const filled: T[] = [];
  // At most ten years of days, whatever the input says.
  for (let day = first, n = 0; day <= last && n < 3700; day = addDays(day, step), n++)
    filled.push(byBucket.get(day) ?? empty(day));
  return filled;
}

/* ------------------------------------------------------------------ Plan windows */

/** The ChatGPT plan's usage windows, as Codex's rate-limit headers name them. */
export const PLAN_WINDOWS = ["primary", "secondary"] as const;
export type PlanWindow = (typeof PLAN_WINDOWS)[number];

/** The header with a window's used percent, and with its length in minutes. */
export function planWindowHeaders(window: PlanWindow) {
  return {
    usedPercent: `x-codex-${window}-used-percent`,
    windowMinutes: `x-codex-${window}-window-minutes`,
  } as const;
}

/** One window as a response's rate-limit headers report it. */
export interface PlanWindowReading {
  usedPercent: number;
  windowMinutes: number | null;
}

function finite(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A window's reading from a response's rate-limit headers, or null when it has none. */
export function planWindowReading(
  headers: Record<string, string> | null | undefined,
  window: PlanWindow,
): PlanWindowReading | null {
  if (!headers) return null;
  const names = planWindowHeaders(window);
  const used = finite(headers[names.usedPercent]);
  if (used === null) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowMinutes: finite(headers[names.windowMinutes]),
  };
}

/** A window's length in words: "5-hour window", "Weekly window", "30-minute window". */
export function planWindowLabel(minutes: number | null, window: PlanWindow): string {
  if (minutes === null) return window === "primary" ? "Short window" : "Long window";
  if (minutes === 10_080) return "Weekly window";
  if (minutes === 1_440) return "Daily window";
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

/**
 * The month API key spend is counted in, as the monthly cap counts it: a UTC calendar month,
 * named with that basis ("November (UTC)") so it never reads as a local date it isn't.
 */
export function capMonthLabel(monthStart: Date | string): string {
  const month = new Date(monthStart).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} (UTC)`;
}
