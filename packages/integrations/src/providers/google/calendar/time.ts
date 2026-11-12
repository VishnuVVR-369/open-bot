/** Wall-clock times in a time zone, and free time between busy blocks. Pure, so it's tested alone. */

export interface Interval {
  start: Date;
  end: Date;
}

export interface WorkingHours {
  /** "09:00" */
  start: string;
  /** "18:00" */
  end: string;
  /** ISO weekdays: 1 is Monday, 7 is Sunday. */
  days: number[];
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** find_free_time looks at most this far ahead. */
export const MAX_WINDOW_DAYS = 62;

function parts(date: Date, timeZone: string) {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** How far the zone is ahead of UTC at that moment, in milliseconds. */
export function zoneOffset(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / MINUTE) * MINUTE;
}

/** The moment a wall-clock time happens in a zone. */
export function zonedTime(
  date: { year: number; month: number; day: number },
  time: string,
  timeZone: string,
): Date {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = guess - zoneOffset(new Date(guess), timeZone);
  // Around a DST change the offset at the answer can differ from the guess's.
  return new Date(guess - zoneOffset(new Date(first), timeZone));
}

/** RFC 3339 with the zone's offset, like 2026-11-06T10:00:00+01:00. */
export function isoInZone(date: Date, timeZone: string): string {
  const offset = zoneOffset(date, timeZone) / MINUTE;
  const p = parts(date, timeZone);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "Thu 6 Nov, 10:00" in the zone. */
export function readableTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** Busy blocks sorted and merged where they touch or overlap. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const entry of sorted) {
    const last = merged[merged.length - 1];
    if (last && entry.start <= last.end) {
      if (entry.end > last.end) last.end = entry.end;
    } else merged.push({ start: entry.start, end: entry.end });
  }
  return merged;
}

/**
 * Free stretches of at least `minutes` between `from` and `to`, outside the busy blocks, within
 * working hours when given (in `timeZone`). At most `max`, earliest first.
 */
export function freeTime(input: {
  busy: Interval[];
  from: Date;
  to: Date;
  minutes: number;
  timeZone: string;
  hours: WorkingHours | null;
  max: number;
}): Interval[] {
  const { from, timeZone, hours } = input;
  const to = new Date(Math.min(input.to.getTime(), from.getTime() + MAX_WINDOW_DAYS * DAY));
  if (to <= from) return [];
  const windows: Interval[] = [];
  if (!hours) windows.push({ start: from, end: to });
  else {
    const first = parts(from, timeZone);
    for (let offset = 0; offset <= MAX_WINDOW_DAYS + 1; offset += 1) {
      const day = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
      const date = {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
      };
      const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
      const start = zonedTime(date, hours.start, timeZone);
      if (start >= to) break;
      if (!hours.days.includes(weekday)) continue;
      const end = zonedTime(date, hours.end, timeZone);
      const clipped = {
        start: start < from ? from : start,
        end: end > to ? to : end,
      };
      if (clipped.end > clipped.start) windows.push(clipped);
    }
  }
  const busy = mergeIntervals(input.busy);
  const free: Interval[] = [];
  const length = input.minutes * MINUTE;
  for (const window of windows) {
    let cursor = window.start;
    for (const block of busy) {
      if (block.end <= cursor) continue;
      if (block.start >= window.end) break;
      if (block.start.getTime() - cursor.getTime() >= length)
        free.push({ start: cursor, end: block.start });
      if (block.end > cursor) cursor = block.end;
      if (cursor >= window.end) break;
    }
    if (window.end.getTime() - cursor.getTime() >= length)
      free.push({ start: cursor, end: window.end });
    if (free.length >= input.max) break;
  }
  return free.slice(0, input.max);
}
