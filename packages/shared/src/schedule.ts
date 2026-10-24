import { CronExpressionParser } from "cron-parser";

/** Offset of `timeZone` from UTC at `date`, in minutes. */
function offsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a date-time. Values with an offset or "Z" are absolute; values without one
 * (like "2026-10-14T09:00") are read as wall-clock time in `timeZone`.
 */
export function parseLocalDateTime(value: string, timeZone: string): Date {
  const trimmed = value.trim();
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date-time: ${value}`);
    return date;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid date-time: ${value}. Use a format like 2026-10-14T09:00.`);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const wallClockAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  // Two passes handle a wall-clock time near a daylight saving change.
  let guess = wallClockAsUtc - offsetMinutes(new Date(wallClockAsUtc), timeZone) * 60_000;
  guess = wallClockAsUtc - offsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

/** A moment as wall-clock time in `timeZone`, like "2026-10-14T09:00", for a date-time input. */
export function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export type Cadence = "daily" | "weekdays" | "weekly" | "hourly" | "custom";

/** A cron expression in the terms of the schedule form, so it can be edited the same way. */
export function cadenceOf(cron: string): {
  cadence: Cadence;
  time: string;
  weekday: string;
} {
  const fields = cron.trim().split(/\s+/);
  const custom = { cadence: "custom" as const, time: "09:00", weekday: "1" };
  if (fields.length !== 5) return custom;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const number = (value: string, max: number) =>
    /^\d{1,2}$/.test(value) && Number(value) <= max ? Number(value) : null;
  const m = number(minute, 59);
  if (m === null || dom !== "*" || month !== "*") return custom;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hour === "*" && dow === "*") return { cadence: "hourly", time: `09:${pad(m)}`, weekday: "1" };
  const h = number(hour, 23);
  if (h === null) return custom;
  const time = `${pad(h)}:${pad(m)}`;
  if (dow === "*") return { cadence: "daily", time, weekday: "1" };
  if (dow === "1-5") return { cadence: "weekdays", time, weekday: "1" };
  const day = number(dow, 6);
  if (day !== null) return { cadence: "weekly", time, weekday: String(day) };
  return custom;
}

/** The cron expression for a cadence picked in the schedule form. */
export function cadenceCron(
  cadence: Cadence,
  time: string,
  weekday: string,
  custom: string,
): string {
  const [hour = "9", minute = "0"] = time.split(":");
  const h = String(Number(hour));
  const m = String(Number(minute));
  switch (cadence) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${weekday}`;
    case "hourly":
      return `${m} * * * *`;
    case "custom":
      return custom.trim();
  }
}

export function validateCron(cron: string, timeZone: string): string | null {
  if (cron.trim().split(/\s+/).length !== 5)
    return "Use a 5-field cron expression, like 0 8 * * 1-5.";
  try {
    CronExpressionParser.parse(cron, { tz: timeZone });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid cron expression";
  }
}

export function nextCronRun(cron: string, timeZone: string, after: Date = new Date()): Date {
  return CronExpressionParser.parse(cron, { tz: timeZone, currentDate: after }).next().toDate();
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function time(hour: string, minute: string) {
  const h = Number(hour);
  const m = Number(minute);
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** A readable description of common cron expressions, falling back to the expression itself. */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const simpleTime = /^\d+$/.test(minute) && /^\d+$/.test(hour);
  if (
    minute.startsWith("*/") &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (
    /^\d+$/.test(minute) &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every hour at :${minute.padStart(2, "0")}`;
  }
  if (!simpleTime || month !== "*") return cron;
  const at = time(hour, minute);
  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}`;
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${at}`;
  if (dayOfMonth === "*" && (dayOfWeek === "0,6" || dayOfWeek === "6,0"))
    return `Weekends at ${at}`;
  if (dayOfMonth === "*" && /^\d$/.test(dayOfWeek))
    return `Every ${WEEKDAYS[Number(dayOfWeek) % 7]} at ${at}`;
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `Monthly on day ${dayOfMonth} at ${at}`;
  return cron;
}
