import type { ModelLogRunFilters } from "@open-bot/api";
import { RUN_LOG_STATUSES, type RunLogStatus } from "@open-bot/domain";

/**
 * The date ranges the model log tabs offer, and the filters they keep in the page's address, so
 * a filtered view can be reloaded, shared with yourself, or opened again from the browser's
 * history. Ranges are whole days in the browser's time zone, so the queries they make stay the
 * same all day and keep their cache.
 */

export const RANGE_PRESETS = [
  { id: "1d", label: "Today", days: 1 },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "365d", label: "Last 12 months", days: 365 },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["id"];

/** A range as the address keeps it: a preset, whole days, or none (any time). */
export type RangeChoice =
  | { kind: "any" }
  | { kind: "preset"; id: RangePreset }
  | { kind: "days"; from: string | null; to: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight at the start of a `YYYY-MM-DD` day, in the browser's time zone. */
function startOf(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** A date's day as `YYYY-MM-DD`, in the browser's time zone. */
export function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The range in the address: `range=7d`, or `from` and `to` days, else any time. */
export function rangeOf(params: URLSearchParams, fallback?: RangePreset): RangeChoice {
  const preset = RANGE_PRESETS.find((p) => p.id === params.get("range"));
  if (preset) return { kind: "preset", id: preset.id };
  const from = params.get("from");
  const to = params.get("to");
  const valid = (day: string | null) => (day && DAY.test(day) ? day : null);
  if (valid(from) || valid(to)) return { kind: "days", from: valid(from), to: valid(to) };
  return fallback ? { kind: "preset", id: fallback } : { kind: "any" };
}

/**
 * The range's bounds as times: from the start of its first day to the start of the day after
 * its last. A preset ends after today.
 */
export function rangeBounds(
  choice: RangeChoice,
  today: Date = new Date(),
): { from?: string; to?: string } {
  if (choice.kind === "any") return {};
  if (choice.kind === "preset") {
    const days = RANGE_PRESETS.find((p) => p.id === choice.id)!.days;
    const tomorrow = addDays(startOf(dayOf(today)), 1);
    return { from: addDays(tomorrow, -days).toISOString(), to: tomorrow.toISOString() };
  }
  return {
    ...(choice.from ? { from: startOf(choice.from).toISOString() } : {}),
    ...(choice.to ? { to: addDays(startOf(choice.to), 1).toISOString() } : {}),
  };
}

/** The range in words, for a button or a heading. */
export function rangeLabel(choice: RangeChoice): string {
  if (choice.kind === "any") return "Any time";
  if (choice.kind === "preset") return RANGE_PRESETS.find((p) => p.id === choice.id)!.label;
  const short = (day: string) =>
    startOf(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (choice.from && choice.to)
    return choice.from === choice.to
      ? short(choice.from)
      : `${short(choice.from)} to ${short(choice.to)}`;
  if (choice.from) return `Since ${short(choice.from)}`;
  return `Until ${short(choice.to!)}`;
}

/** The range written back into the address. */
export function withRange(params: URLSearchParams, choice: RangeChoice): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ["range", "from", "to"]) next.delete(key);
  if (choice.kind === "preset") next.set("range", choice.id);
  if (choice.kind === "days") {
    if (choice.from) next.set("from", choice.from);
    if (choice.to) next.set("to", choice.to);
  }
  return next;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The runs list's filters, from the address; anything malformed is left out. */
export function runFiltersOf(params: URLSearchParams, today?: Date): ModelLogRunFilters {
  const id = (key: string) => {
    const value = params.get(key);
    return value && UUID.test(value) ? value : undefined;
  };
  const status = params.get("status");
  const access = params.get("access");
  const q = params.get("q")?.trim();
  const model = params.get("model");
  return {
    ...(id("teammate") ? { teammateId: id("teammate") } : {}),
    ...(id("chat") ? { chatId: id("chat") } : {}),
    ...(model ? { model: model.slice(0, 200) } : {}),
    ...(status && (RUN_LOG_STATUSES as readonly string[]).includes(status)
      ? { status: status as RunLogStatus }
      : {}),
    ...(access === "plan" || access === "api_key" ? { access } : {}),
    ...rangeBounds(rangeOf(params), today),
    ...(q ? { q: q.slice(0, 1000) } : {}),
  };
}

/** The export link for a range, or null when there is no range to export. */
export function exportRangeHref(bounds: { from?: string; to?: string }): string | null {
  if (!bounds.from && !bounds.to) return null;
  const query = new URLSearchParams();
  if (bounds.from) query.set("from", bounds.from);
  if (bounds.to) query.set("to", bounds.to);
  return `/api/model-logs/export?${query}`;
}

/** The export link for one run. */
export function exportRunHref(runId: string): string {
  return `/api/model-logs/export?runId=${runId}`;
}
