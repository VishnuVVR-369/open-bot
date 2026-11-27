import type { ScheduleView, SchedulePatch, TriggerPatch, TriggerView } from "@open-bot/api";
import {
  describeAccountWatch,
  describeInterval,
  isAccountTrigger,
  isFinishedReminder,
  LAST_RUN_TEXT,
  nextRunLabel,
  otherZoneLabel,
  relativeTime,
  runIsHeldBack,
  SCHEDULE_DELETE_TEXT,
  SCHEDULE_EMPTY_HISTORY,
  sameTiming,
  scheduleCadence,
  shortPageUrl,
  timingForm,
  timingOf,
  timingProblem,
  TRIGGER_CHECK_FAILED,
  TRIGGER_DELETE_TEXT,
  TRIGGER_EMPTY_HISTORY,
  viewerTimeZone,
  WAITING_FOR_COMPUTER,
  type ScheduleTimingForm,
  type TriggerKind,
} from "@open-bot/domain";
import type { Href } from "expo-router";

/** A schedule or a trigger (page watch, webhook, Gmail or Calendar), told apart by `type`. */
export type Automation =
  ({ type: "schedule" } & ScheduleView) | ({ type: "trigger" } & TriggerView);
export type AutomationType = Automation["type"];

export const isAutomationType = (value: unknown): value is AutomationType =>
  value === "schedule" || value === "trigger";

/** Where the list, each automation and its editor live in the app. */
export const AUTOMATIONS_HREF = "/automations" satisfies Href;
export const automationsHref = (teammateId?: string | null): Href =>
  teammateId ? `/automations?teammate=${encodeURIComponent(teammateId)}` : AUTOMATIONS_HREF;
export const automationHref = (automation: Pick<Automation, "type" | "id">): Href =>
  `/automations/${automation.type}/${automation.id}`;
export const automationEditHref = (automation: Pick<Automation, "type" | "id">): Href =>
  `/automations/${automation.type}/${automation.id}/edit`;

/** The automation's own screen, as the app's stack names it. */
const AUTOMATION_ROUTE = "automations/[kind]/[automationId]/index";

/**
 * Whether the screen under the editor is the automation's own, so a save goes back to it. Opened
 * from a link, the editor may sit on whatever was open before (a profile, a chat), and a save
 * then opens the automation instead of returning there.
 */
export function editorReturnsToAutomation(
  previous: { name: string; params?: object } | undefined,
  automation: Pick<Automation, "type" | "id">,
): boolean {
  const params = previous?.params as { kind?: unknown; automationId?: unknown } | undefined;
  return (
    previous?.name === AUTOMATION_ROUTE &&
    params?.kind === automation.type &&
    params.automationId === automation.id
  );
}

export const asSchedule = (view: ScheduleView): Automation => ({ type: "schedule", ...view });
export const asTrigger = (view: TriggerView): Automation => ({ type: "trigger", ...view });

/** The automation with this id, from the lists the server last sent, or null. */
export function findAutomation(
  type: AutomationType,
  id: string,
  schedules: readonly ScheduleView[] | undefined,
  triggers: readonly TriggerView[] | undefined,
): Automation | null {
  if (type === "schedule") {
    const view = schedules?.find((entry) => entry.id === id);
    return view ? asSchedule(view) : null;
  }
  const view = triggers?.find((entry) => entry.id === id);
  return view ? asTrigger(view) : null;
}

export type SectionKey = "schedule" | "watch" | "accounts" | "webhook";

/** The list's sections, in the web's order, and what each says while it's empty. */
export const SECTIONS: readonly { key: SectionKey; heading: string; empty: string }[] = [
  { key: "schedule", heading: "Schedules", empty: "Routines and reminders, at the times you set." },
  { key: "watch", heading: "Page watches", empty: "Wake a teammate when a page changes." },
  {
    key: "accounts",
    heading: "Mail and calendar",
    empty: "Wake a teammate when mail arrives, or before an event.",
  },
  {
    key: "webhook",
    heading: "Webhooks",
    empty: "A private URL that starts a teammate when another service calls it.",
  },
];

const sectionOf = (automation: Automation): SectionKey =>
  automation.type === "schedule"
    ? "schedule"
    : isAccountTrigger(automation.kind)
      ? "accounts"
      : automation.kind;

/** The automations by section, everyone's or one teammate's, each in the order they were made. */
export function automationSections(
  schedules: readonly ScheduleView[],
  triggers: readonly TriggerView[],
  teammateId: string | null = null,
): { key: SectionKey; heading: string; empty: string; items: Automation[] }[] {
  const all = [...schedules.map(asSchedule), ...triggers.map(asTrigger)].filter(
    (automation) => !teammateId || automation.teammateId === teammateId,
  );
  return SECTIONS.map((section) => ({
    ...section,
    items: all.filter((automation) => sectionOf(automation) === section.key),
  }));
}

/** "Off", or "Done" for a reminder that already ran; nothing while it's on. */
export function stateBadge(automation: Automation): string | null {
  if (automation.enabled) return null;
  return automation.type === "schedule" && isFinishedReminder(automation) ? "Done" : "Off";
}

/** Whether it has an on/off switch: a reminder that already ran won't run again. */
export const canTurnOn = (automation: Automation) =>
  automation.type === "trigger" || !isFinishedReminder(automation);

/** The one thing to do to it right now: run a schedule, or look at what a trigger watches. */
export function mainAction(
  automation: Automation,
): { kind: "run" | "check"; label: string } | null {
  if (automation.type === "schedule") return { kind: "run", label: "Run now" };
  if (automation.kind === "webhook") return null;
  return { kind: "check", label: "Check now" };
}

/** "tomorrow 9:00 AM", or "Wed 9:00 AM" further out, on `timeZone`'s clock. */
const soonText = (iso: string, timeZone: string, now: Date) =>
  nextRunLabel(iso, timeZone, now).replace(/^(Today|Tomorrow)/, (word) => word.toLowerCase());

/**
 * When a reminder runs: "Once, today 9:00 AM" when that's today or tomorrow, else its date. It
 * runs only at that time, so a "next" would say the same thing twice.
 */
function onceText(schedule: ScheduleView, now: Date): string {
  if (schedule.enabled && schedule.nextRunAt) {
    const soon = soonText(schedule.nextRunAt, schedule.timezone, now);
    if (/^(today|tomorrow) /.test(soon)) return `Once, ${soon}`;
  }
  return scheduleCadence(schedule);
}

/** Said of a schedule that tells you only when something changed. */
export const QUIET_TEXT = "tells you only if something changed";

/**
 * When it runs, or what it watches, in one line under its title, as the web's row says it. A
 * schedule's times are all on its own clock, which the line names when it isn't the phone's.
 */
export function whenLine(
  automation: Automation,
  {
    now = new Date(),
    computerOnline = true,
    phoneZone = viewerTimeZone(),
  }: { now?: Date; computerOnline?: boolean; phoneZone?: string } = {},
): string {
  if (automation.type === "schedule") {
    const once = automation.kind === "once";
    const parts = [once ? onceText(automation, now) : scheduleCadence(automation)];
    if (automation.enabled && automation.nextRunAt) {
      if (runIsHeldBack(automation.nextRunAt, now.getTime(), computerOnline))
        parts.push(WAITING_FOR_COMPUTER.toLowerCase());
      else if (!once)
        parts.push(`next ${soonText(automation.nextRunAt, automation.timezone, now)}`);
    }
    const zone = otherZoneLabel(automation.timezone, phoneZone);
    if (zone) parts.push(zone);
    if (automation.quiet) parts.push(QUIET_TEXT);
    return parts.join(" · ");
  }
  if (isAccountTrigger(automation.kind))
    return `${automation.account ?? "No account"} · ${describeAccountWatch(automation)}`;
  if (automation.kind === "webhook")
    return `Webhook · ${automation.lastFiredAt ? `last called ${relativeTime(automation.lastFiredAt, now.getTime())}` : "not called yet"}`;
  const parts = [
    shortPageUrl(automation.url ?? ""),
    describeInterval(automation.intervalMinutes ?? 60).toLowerCase(),
  ];
  if (automation.lookFor) parts.push(`waiting for “${automation.lookFor}”`);
  return parts.join(" · ");
}

/**
 * A line that Android wraps only where it reads well: never inside "8:00 AM", and never before a
 * " · ", which would start the next line with the dot.
 */
export const keepPartsWhole = (line: string) =>
  line.replace(/(\d) (AM|PM)\b/g, "$1\u00a0$2").replaceAll(" · ", "\u00a0· ");

/** How it went last, under the timing: a failed check in red, or its last run. */
export function lastLine(
  automation: Automation,
  now: Date = new Date(),
): { text: string; failed: boolean } | null {
  const ago = (iso: string) => relativeTime(iso, now.getTime());
  if (automation.type === "schedule") {
    if (!automation.lastRun) return null;
    const last = automation.lastRunAt ? ` ${ago(automation.lastRunAt)}` : "";
    return { text: `${LAST_RUN_TEXT[automation.lastRun.status]}${last}`, failed: false };
  }
  if (automation.lastError)
    return { text: `Last check failed: ${automation.lastError}`, failed: true };
  if (automation.lastRun) {
    const last = automation.lastFiredAt ? ` ${ago(automation.lastFiredAt)}` : "";
    return { text: `${LAST_RUN_TEXT[automation.lastRun.status]}${last}`, failed: false };
  }
  if (automation.kind === "webhook") return null;
  if (!automation.lastCheckedAt) return { text: "Checking for the first time…", failed: false };
  const nothing =
    automation.kind === "watch"
      ? "No changes yet"
      : automation.kind === "gmail"
        ? "No new mail yet"
        : "Nothing coming up yet";
  return { text: `${nothing} · checked ${ago(automation.lastCheckedAt)}`, failed: false };
}

/** Said in place of its history before its first run. */
export const emptyHistory = (automation: Automation) =>
  automation.type === "schedule" ? SCHEDULE_EMPTY_HISTORY : TRIGGER_EMPTY_HISTORY[automation.kind];

/** What deleting it does, under "Delete “…”?". */
export const deleteText = (automation: Automation) =>
  automation.type === "schedule" ? SCHEDULE_DELETE_TEXT : TRIGGER_DELETE_TEXT[automation.kind];

/** What it's called in a sentence: "schedule", "page watch", "webhook", "Gmail trigger". */
export function kindName(automation: Pick<Automation, "type" | "kind">): string {
  if (automation.type === "schedule") return automation.kind === "once" ? "reminder" : "schedule";
  const names: Record<TriggerKind, string> = {
    watch: "page watch",
    webhook: "webhook",
    gmail: "Gmail trigger",
    calendar: "Calendar trigger",
  };
  return names[automation.kind as TriggerKind];
}

/** What the phone can't change, said once on the automation's screen. */
export function webOnlyNote(automation: Automation): string {
  const what =
    automation.type === "schedule"
      ? "what it does"
      : automation.kind === "watch"
        ? "the page, what to look for or what it does"
        : automation.kind === "webhook"
          ? "its URL, test it or change what it does"
          : automation.kind === "gmail"
            ? "the account, which mail wakes it or what it does"
            : "the account, which events wake it or what it does";
  return `To see or change ${what}, open Automations in open-bot on a computer.`;
}

/** The zone a schedule's times are in, and the phone's when they differ, so nothing surprises. */
export function zoneNote(scheduleZone: string, phoneZone: string): string {
  return scheduleZone === phoneZone
    ? `Times in ${unbroken(scheduleZone)}`
    : `Times in ${unbroken(scheduleZone)}. This phone is on ${unbroken(phoneZone)}.`;
}

/** A zone's name kept on one line: Android would break "Asia/Kolkata" after its slash. */
const unbroken = (zone: string) => zone.replaceAll("/", "/\u2060");

/**
 * What a "Run now" did, said honestly: started by this tap, or by an earlier one whose answer was
 * lost (the server found the run it started), so nothing more started. `retried` says whether this
 * tap retried an earlier one: Android's network layer resends a request whose connection dropped,
 * so a single tap can also be answered `started: false`, and then it was this tap that started it.
 */
export function runNowOutcome(
  schedule: Pick<ScheduleView, "title">,
  answer: { started?: boolean },
  teammateName: string,
  retried: boolean,
): { title: string; body: string; failed: boolean } {
  // A server from before `started` says nothing: it started a run.
  if (answer.started === false && retried)
    return {
      title: `“${schedule.title}” was already started`,
      body: `Your earlier tap went through, so nothing more started. ${teammateName} is on it.`,
      failed: false,
    };
  return { title: `Started “${schedule.title}”`, body: `${teammateName} is on it.`, failed: false };
}

/** What "Check now" found, as the web's notice says it. */
export function checkOutcome(
  trigger: Pick<TriggerView, "kind" | "title">,
  result: { ok: boolean; changed: boolean; summary: string },
  teammateName: string,
): { title: string; body: string | null; failed: boolean } {
  if (!result.ok)
    return { title: TRIGGER_CHECK_FAILED[trigger.kind], body: result.summary, failed: true };
  if (result.changed)
    return {
      title: trigger.kind === "watch" ? `“${trigger.title}” changed` : trigger.title,
      body: `${result.summary}. ${teammateName} is on it.`,
      failed: false,
    };
  return { title: result.summary, body: null, failed: false };
}

/* ------------------------------------------------------------------ Editing */

/** What the phone edits: its name, and its timing where it has one the phone can set. */
export interface AutomationForm {
  title: string;
  /** Schedules: when it runs. */
  timing: ScheduleTimingForm | null;
  /** Page watches: how often the page is looked at. */
  intervalMinutes: number | null;
  /** Calendar triggers: how long before an event it wakes the teammate. */
  leadMinutes: number | null;
}

export const TITLE_MAX = 80;

/** The form for the automation as it is, with times on the schedule's own clock. */
export function automationForm(automation: Automation, now: Date = new Date()): AutomationForm {
  if (automation.type === "schedule")
    return {
      title: automation.title,
      timing: timingForm(automation, automation.timezone, now),
      intervalMinutes: null,
      leadMinutes: null,
    };
  return {
    title: automation.title,
    timing: null,
    intervalMinutes: automation.kind === "watch" ? (automation.intervalMinutes ?? 60) : null,
    leadMinutes: automation.kind === "calendar" ? (automation.leadMinutes ?? 30) : null,
  };
}

/** Each field that differs between two forms. */
function changedFields(start: AutomationForm, form: AutomationForm): (keyof AutomationForm)[] {
  const fields: (keyof AutomationForm)[] = [];
  if (start.title.trim() !== form.title.trim()) fields.push("title");
  if (start.timing && form.timing && !sameTiming(start.timing, form.timing)) fields.push("timing");
  if (start.intervalMinutes !== form.intervalMinutes) fields.push("intervalMinutes");
  if (start.leadMinutes !== form.leadMinutes) fields.push("leadMinutes");
  return fields;
}

export const formChanged = (start: AutomationForm, form: AutomationForm) =>
  changedFields(start, form).length > 0;

/** The form and where it started: what's sent is the difference from it. */
export interface AutomationDraft {
  start: AutomationForm;
  form: AutomationForm;
}

/**
 * A fresher copy of the automation (it changed on the web, say): what you haven't touched follows
 * it, and what you changed stays yours.
 */
export function rebaseForm(draft: AutomationDraft, fresh: AutomationForm): AutomationDraft {
  if (!formChanged(draft.start, fresh)) return draft;
  const touched = changedFields(draft.start, draft.form);
  const form = { ...fresh };
  for (const key of touched) (form as Record<string, unknown>)[key] = draft.form[key];
  return { start: fresh, form };
}

/**
 * What the editor says about a quiet routine (it tells you only when something changed): that it
 * is, or that making it a one-time reminder drops that, since a reminder always tells you. Null
 * for one that isn't quiet.
 */
export function quietNote(automation: Automation, form: AutomationForm): string | null {
  if (automation.type !== "schedule" || !automation.quiet) return null;
  if (form.timing?.kind === "once")
    return "As a one-time reminder it will tell you how it went, so it won't stay quiet.";
  return "It tells you only if something changed. Change that in open-bot on a computer.";
}

/** Why the form can't be saved, in the worker's words, or null when it can. */
export function formProblem(
  automation: Automation,
  form: AutomationForm,
  now: Date = new Date(),
): string | null {
  const title = form.title.trim();
  if (!title) return "Give it a name.";
  if (title.length > TITLE_MAX) return `Keep the name under ${TITLE_MAX} characters.`;
  if (automation.type === "schedule" && form.timing)
    return timingProblem(form.timing, automation.timezone, now);
  return null;
}

/** Only what changed, for `schedules.patch` or `triggers.patch`; null when nothing did. */
export function patchOf(
  automation: Automation,
  start: AutomationForm,
  form: AutomationForm,
): { type: "schedule"; patch: SchedulePatch } | { type: "trigger"; patch: TriggerPatch } | null {
  const fields = changedFields(start, form);
  if (fields.length === 0) return null;
  const title = fields.includes("title") ? { title: form.title.trim() } : {};
  if (automation.type === "schedule")
    return {
      type: "schedule",
      patch: {
        scheduleId: automation.id,
        ...title,
        ...(fields.includes("timing") && form.timing ? { timing: timingOf(form.timing) } : {}),
      },
    };
  return {
    type: "trigger",
    patch: {
      triggerId: automation.id,
      ...title,
      ...(fields.includes("intervalMinutes") && form.intervalMinutes !== null
        ? { intervalMinutes: form.intervalMinutes }
        : {}),
      ...(fields.includes("leadMinutes") && form.leadMinutes !== null
        ? { leadMinutes: form.leadMinutes }
        : {}),
    },
  };
}

/* ------------------------------------------------------------------ Retries */

/** How long a "Run now" id is kept for a retry after a try whose answer was lost. */
export const RETRY_WINDOW_MS = 2 * 60_000;

/**
 * The id of each ask that must not happen twice ("Run now"), kept for retries until it goes
 * through, so asking again after an answer was lost finds the first run instead of starting one.
 * Only for a short while after the last try: a tap much later is a new ask, not a retry, and
 * must start a run of its own.
 */
export class RetryKeys {
  private readonly keys = new Map<string, { key: string; at: number }>();

  constructor(
    private readonly newKey: () => string,
    private readonly windowMs: number = RETRY_WINDOW_MS,
  ) {}

  for(name: string, now: number = Date.now()): string {
    const key = this.kept(name, now) ?? this.newKey();
    this.keys.set(name, { key, at: now });
    return key;
  }

  /** Whether the next ask for `name` retries an earlier one that wasn't answered. */
  retries(name: string, now: number = Date.now()): boolean {
    return this.kept(name, now) !== null;
  }

  private kept(name: string, now: number): string | null {
    const kept = this.keys.get(name);
    return kept && now - kept.at <= this.windowMs ? kept.key : null;
  }

  /** The ask went through, or was refused: the next one is a new ask. */
  done(name: string) {
    this.keys.delete(name);
  }

  /** Every ask kept so far is forgotten (the screen that made them closed). */
  clear() {
    this.keys.clear();
  }
}

/* ------------------------------------------------------------------ Time pickers */

/** "9:00 AM" for a form's "09:00". */
export function timeLabel(time: string): string {
  const [hour = "9", minute = "0"] = time.split(":");
  const h = Number(hour);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${minute.padStart(2, "0")} ${suffix}`;
}

/** "09:00" from a 12-hour clock's hour (1 to 12), minute and half of the day. */
export function timeOf(hour12: number, minute: number, pm: boolean): string {
  const hour = (hour12 % 12) + (pm ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A form's "09:00" on a 12-hour clock. */
export function clockOf(time: string): { hour12: number; minute: number; pm: boolean } {
  const [hour = "9", minute = "0"] = time.split(":");
  const h = Number(hour);
  return { hour12: h % 12 === 0 ? 12 : h % 12, minute: Number(minute), pm: h >= 12 };
}

/** The minutes a time picker offers: every five, with the current one kept. */
export function minuteChoices(current: number): number[] {
  const minutes = Array.from({ length: 12 }, (_, index) => index * 5);
  if (!minutes.includes(current)) minutes.push(current);
  return minutes.sort((a, b) => a - b);
}

/** A reminder's "2026-12-01T09:00", split for its day and time pickers, and put back together. */
export const reminderDay = (at: string) => at.slice(0, 10);
export const reminderTime = (at: string) => at.slice(11, 16);
export const reminderAt = (day: string, time: string) => `${day}T${time}`;
