/** Lists that read by day: "Today", "Yesterday", then broader buckets for what's older. */

export type DayGroup = "Today" | "Yesterday" | "Earlier this week" | "Earlier" | "Older";

const DAY_MS = 86_400_000;

/**
 * Which day bucket a time falls in. With `week`, the last seven days get their own bucket before
 * "Older"; without it, everything before yesterday is "Earlier".
 */
export function dayGroup(iso: string, now = Date.now(), week = false): DayGroup {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const then = new Date(iso).getTime();
  if (then >= today.getTime()) return "Today";
  if (then >= today.getTime() - DAY_MS) return "Yesterday";
  if (!week) return "Earlier";
  return then >= today.getTime() - 6 * DAY_MS ? "Earlier this week" : "Older";
}

/** Items (newest first) split into day sections, in the order the days first appear. */
export function groupByDay<T>(
  items: T[],
  when: (item: T) => string,
  { now = Date.now(), week = false }: { now?: number; week?: boolean } = {},
): { title: DayGroup; data: T[] }[] {
  const groups = new Map<DayGroup, T[]>();
  for (const item of items) {
    const group = dayGroup(when(item), now, week);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return [...groups].map(([title, data]) => ({ title, data }));
}

/** "just now", "5m ago" or "3h ago" for earlier today; null for anything before today. */
export function recently(iso: string, now = Date.now()): string | null {
  if (dayGroup(iso, now) !== "Today") return null;
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
