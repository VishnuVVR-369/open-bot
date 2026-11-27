// When a schedule runs, as the web's dialog and the phone's editor set it: the form, the timing it
// saves, why it can't be saved, and how it reads. Times are wall-clock in the schedule's own zone.
import {
  type Cadence,
  cadenceCron,
  cadenceOf,
  describeCron,
  formatLocalDateTime,
  parseLocalDateTime,
  type ScheduleKind,
  validateCron,
} from "./schedules";

/** The cadences the schedule form offers, in its order. */
export const CADENCES: readonly { value: Cadence; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "hourly", label: "Every hour" },
  { value: "custom", label: "Custom (cron)" },
];

/** A schedule's timing as the form edits it. */
export interface ScheduleTimingForm {
  kind: ScheduleKind;
  cadence: Cadence;
  /** "09:00", 24-hour. An hourly cadence uses only its minutes. */
  time: string;
  /** Cron's day of the week, "0" (Sunday) to "6". */
  weekday: string;
  /** The cron expression a custom cadence runs on. */
  custom: string;
  /** A reminder's time, like "2026-12-01T09:00", wall-clock in the schedule's zone. */
  at: string;
}

/** What a schedule saves for its timing: exactly one of the two. */
export interface ScheduleTiming {
  cron: string | null;
  at: string | null;
}

/** On the hour, half an hour to an hour and a half from now, as wall-clock time in `timeZone`. */
export function defaultReminderAt(timeZone: string, now: Date = new Date()): string {
  // Floored on the zone's own clock, so a zone half an hour off UTC still gets a time on its hour.
  const local = formatLocalDateTime(new Date(now.getTime() + 90 * 60_000), timeZone);
  return `${local.slice(0, 14)}00`;
}

/** The form for a schedule as it is, or a new one (weekdays at 9) without one. */
export function timingForm(
  schedule: {
    kind: ScheduleKind;
    cron: string | null;
    runAt: string | null;
    timezone: string;
  } | null,
  timeZone: string,
  now: Date = new Date(),
): ScheduleTimingForm {
  const parsed = schedule?.cron
    ? cadenceOf(schedule.cron)
    : { cadence: "weekdays" as const, time: "09:00", weekday: "1" };
  const runAt = schedule?.runAt ? new Date(schedule.runAt) : null;
  return {
    kind: schedule?.kind ?? "cron",
    ...parsed,
    custom: schedule?.cron ?? "0 9 * * 1-5",
    // A reminder whose time has passed starts from a time to come.
    at:
      runAt && runAt.getTime() > now.getTime()
        ? formatLocalDateTime(runAt, timeZone)
        : defaultReminderAt(timeZone, now),
  };
}

/** The timing the form saves. */
export function timingOf(form: ScheduleTimingForm): ScheduleTiming {
  if (form.kind === "once") return { cron: null, at: form.at };
  return { cron: cadenceCron(form.cadence, form.time, form.weekday, form.custom), at: null };
}

/** Whether two forms save the same timing. */
export function sameTiming(a: ScheduleTimingForm, b: ScheduleTimingForm): boolean {
  const left = timingOf(a);
  const right = timingOf(b);
  return left.cron === right.cron && left.at === right.at;
}

/** Why the form's timing can't be saved, in the worker's words, or null when it can. */
export function timingProblem(
  form: ScheduleTimingForm,
  timeZone: string,
  now: Date = new Date(),
): string | null {
  const timing = timingOf(form);
  if (timing.cron !== null) return validateCron(timing.cron, timeZone);
  let when: Date;
  try {
    when = parseLocalDateTime(timing.at!, timeZone);
  } catch (error) {
    return error instanceof Error ? error.message : "That isn't a time.";
  }
  // The worker allows a minute, for the time it takes to send.
  if (when.getTime() < now.getTime() - 60_000) return "That time is in the past.";
  return null;
}

/** How the form's timing reads: "Weekdays at 9:00 AM", or the expression a custom one runs on. */
export function timingSummary(form: ScheduleTimingForm): string {
  const timing = timingOf(form);
  return timing.cron !== null ? describeCron(timing.cron) : "Once";
}
