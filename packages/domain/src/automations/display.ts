// How automations read in the app, the same on the web and the phone: their timing in words, how
// their runs went, what deleting one does, and which teammates have their daily check-in on.
import { DAILY_CHECK_IN } from "../teammates/templates";
import type { RunStatus } from "../timeline/timeline";
import { describeCron, type ScheduleKind } from "./schedules";
import {
  CALENDAR_LEADS,
  describeGmailQuery,
  describeInterval,
  describeLead,
  type TriggerKind,
  WATCH_INTERVALS,
} from "./triggers";

/** A run in an automation's history, in a word or two. */
export const AUTOMATION_RUN_STATUS: Record<RunStatus, string> = {
  completed: "Finished",
  failed: "Failed",
  interrupted: "Stopped",
  running: "Running",
  starting: "Starting",
  waiting: "Waiting for you",
  queued: "Starting",
};

/** How the last run went, under an automation's title. */
export const LAST_RUN_TEXT: Record<RunStatus, string> = {
  completed: "Last run finished",
  failed: "Last run failed",
  interrupted: "Last run was stopped",
  running: "Running now",
  starting: "Running now",
  waiting: "Waiting for you",
  queued: "Starting",
};

/** What deleting a schedule does, under "Delete “…”?". */
export const SCHEDULE_DELETE_TEXT = "It won't run again. Past runs stay in their chats.";

/** What deleting a trigger does, by kind. */
export const TRIGGER_DELETE_TEXT: Record<TriggerKind, string> = {
  watch: "The page won't be checked again. Past runs stay in their chats.",
  webhook: "Its URL stops working. Past runs stay in their chats.",
  gmail: "New mail won't wake your teammate any more. Past runs stay in their chats.",
  calendar: "Events won't wake your teammate any more. Past runs stay in their chats.",
};

/** Said in place of a schedule's history before its first run. */
export const SCHEDULE_EMPTY_HISTORY = "It hasn't run yet.";

/** Said in place of a trigger's history before its first run, by kind. */
export const TRIGGER_EMPTY_HISTORY: Record<TriggerKind, string> = {
  watch: "The page hasn't changed yet.",
  webhook: "Nothing has called it yet.",
  gmail: "No new mail has woken it yet.",
  calendar: "No events have come up yet.",
};

/** The heading of a failed "Check now", by kind. */
export const TRIGGER_CHECK_FAILED: Record<TriggerKind, string> = {
  watch: "Couldn't check the page",
  webhook: "Couldn't call the webhook",
  gmail: "Couldn't check for new mail",
  calendar: "Couldn't check the calendar",
};

/** Why "Run now" and "Check now" are off while the computer is offline. */
export const OFFLINE_ACTION = "Works once the computer is back";

/** A scheduled run whose time has come while the computer is offline. */
export const WAITING_FOR_COMPUTER = "Waiting for the computer";

/** Whether a scheduled run is due but can't start: its time has passed and the computer is offline. */
export function runIsHeldBack(nextRunAt: string, now: number, computerOnline: boolean): boolean {
  return !computerOnline && new Date(nextRunAt).getTime() <= now;
}

/** The parts of a moment as wall-clock time in `timeZone` (the viewer's own without one). */
function zoned(date: Date, timeZone?: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    weekday: parts.weekday!,
    month: parts.month!,
    day: parts.day!,
    year: parts.year!,
    time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}`,
  };
}

/** "Mon Nov 30, 9:00 AM": a moment as wall-clock time in `timeZone`, the viewer's without one. */
export function formatWhen(iso: string | Date, timeZone?: string): string {
  const parts = zoned(new Date(iso), timeZone);
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.time}`;
}

/** "Today 4:00 PM", "Tomorrow 8:00 AM", or "Mon 8:00 AM" further out, on the viewer's clock. */
export function nextRunLabel(iso: string | Date, now: Date = new Date()): string {
  const date = new Date(iso);
  const parts = zoned(date);
  const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (dayOf(date) === dayOf(now)) return `Today ${parts.time}`;
  if (dayOf(date) === dayOf(tomorrow)) return `Tomorrow ${parts.time}`;
  return `${parts.weekday} ${parts.time}`;
}

/** When a schedule runs, in words: "Weekdays at 9:00 AM", or "Once, Mon Nov 30, 9:00 AM". */
export function scheduleCadence(schedule: {
  kind: ScheduleKind;
  cron: string | null;
  runAt: string | null;
  timezone: string;
}): string {
  if (schedule.kind === "cron" && schedule.cron) return describeCron(schedule.cron);
  if (schedule.runAt) return `Once, ${formatWhen(schedule.runAt, schedule.timezone)}`;
  return "Once";
}

/** A reminder that already ran: it shows "Done", and has no switch, since it won't run again. */
export function isFinishedReminder(schedule: {
  kind: ScheduleKind;
  enabled: boolean;
  lastRunAt: string | null;
}): boolean {
  return schedule.kind === "once" && Boolean(schedule.lastRunAt) && !schedule.enabled;
}

/** The next few scheduled runs, soonest first, for Home's "Coming up". */
export function comingUp<T extends { enabled: boolean; nextRunAt: string | null }>(
  schedules: readonly T[],
  count = 3,
): T[] {
  return schedules
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, count);
}

/** Whether a schedule is a teammate's daily check-in, which `schedules.setCheckIn` turns on and off. */
export function isDailyCheckIn(schedule: { title: string; quiet: boolean }): boolean {
  return schedule.title === DAILY_CHECK_IN.title && schedule.quiet;
}

/** Whether the teammate's daily check-in is on. */
export function dailyCheckInOn(
  schedules: readonly { teammateId: string; title: string; quiet: boolean; enabled: boolean }[],
  teammateId: string,
): boolean {
  return schedules.some(
    (schedule) =>
      schedule.teammateId === teammateId && isDailyCheckIn(schedule) && schedule.enabled,
  );
}

/** The page, without the scheme, for a compact line. */
export function shortPageUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

/** Which mail, or which events, an account trigger wakes for, in a few words. */
export function describeAccountWatch(trigger: {
  kind: TriggerKind;
  query: string | null;
  leadMinutes: number | null;
}): string {
  if (trigger.kind === "gmail") return describeGmailQuery(trigger.query);
  const events = trigger.query === "guests" ? "event with other people" : "event";
  return `${describeLead(trigger.leadMinutes ?? 30).toLowerCase()} each ${events}`;
}

/** The choices for a timing menu, with the current value kept when the menu doesn't offer it. */
function withCurrent(
  options: readonly { minutes: number; label: string }[],
  current: number | null,
  describe: (minutes: number) => string,
): { minutes: number; label: string }[] {
  const all = [...options];
  if (current !== null && !all.some((option) => option.minutes === current))
    all.push({ minutes: current, label: describe(current) });
  return all;
}

/** How often a page watch can check, with the one it has kept (a teammate may have picked another). */
export const intervalChoices = (current: number | null) =>
  withCurrent(WATCH_INTERVALS, current, describeInterval);

/** How long before an event a Calendar trigger can wake, with the one it has kept. */
export const leadChoices = (current: number | null) =>
  withCurrent(CALENDAR_LEADS, current, describeLead);
