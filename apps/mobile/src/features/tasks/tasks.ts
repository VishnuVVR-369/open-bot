import type { TaskView } from "@open-bot/api";
import {
  daysUntil,
  dueLabel,
  dueState,
  formatDay,
  isOverdue,
  parseDay,
  TASK_BLOCKER_TEXT,
  TASK_NOTES_MAX,
  TASK_STATUS_LABELS,
  TASK_TITLE_MAX,
  waitsOnYou,
  type TaskBlocker,
  type TaskStatus,
} from "@open-bot/domain";
import type { Href } from "expo-router";

/** Where the board and each task live in the app. */
export const TASKS_HREF = "/tasks" satisfies Href;
export const taskHref = (taskId: string): Href => `/tasks/${taskId}`;
export const newTaskHref = (ownerTeammateId?: string | null): Href =>
  ownerTeammateId ? `/tasks/new?owner=${encodeURIComponent(ownerTeammateId)}` : "/tasks/new";

/** The task with this id as the board has it now, or null (none asked for, or it's gone). */
export const taskById = <T extends { id: string }>(tasks: readonly T[], id: string | null) =>
  (id !== null && tasks.find((task) => task.id === id)) || null;

/** What the task screen edits. */
export interface TaskForm {
  title: string;
  notes: string;
  /** Null is you. */
  ownerTeammateId: string | null;
  dueOn: string | null;
  status: TaskStatus;
}

export function emptyTaskForm(ownerTeammateId: string | null = null): TaskForm {
  return { title: "", notes: "", ownerTeammateId, dueOn: null, status: "todo" };
}

export function taskForm(task: TaskView): TaskForm {
  return {
    title: task.title,
    notes: task.notes,
    ownerTeammateId: task.ownerTeammateId,
    dueOn: task.dueOn,
    status: task.status,
  };
}

/** Why the form can't be saved yet, in the worker's words, or null when it can. */
export function taskFormProblem(form: TaskForm): string | null {
  const title = form.title.trim();
  if (!title) return "Give the task a title.";
  if (title.length > TASK_TITLE_MAX) return `Keep the title under ${TASK_TITLE_MAX} characters.`;
  if (form.notes.length > TASK_NOTES_MAX)
    return `Keep the notes under ${TASK_NOTES_MAX} characters.`;
  return null;
}

/** Whether the form says something different from where it started. */
export function taskFormChanged(start: TaskForm, form: TaskForm): boolean {
  return Object.keys(taskChanges(start, form)).length > 0;
}

export interface TaskChanges {
  title?: string;
  notes?: string;
  ownerTeammateId?: string | null;
  dueOn?: string | null;
  status?: TaskStatus;
}

/**
 * Only what you changed since you opened the task, so a field a teammate changed meanwhile isn't
 * written back over. The worker trims the title and notes, so whitespace alone isn't a change.
 */
export function taskChanges(start: TaskForm, form: TaskForm): TaskChanges {
  const changes: TaskChanges = {};
  if (form.title.trim() !== start.title.trim()) changes.title = form.title.trim();
  if (form.notes.trim() !== start.notes.trim()) changes.notes = form.notes.trim();
  if (form.ownerTeammateId !== start.ownerTeammateId)
    changes.ownerTeammateId = form.ownerTeammateId;
  if (form.dueOn !== start.dueOn) changes.dueOn = form.dueOn;
  if (form.status !== start.status) changes.status = form.status;
  return changes;
}

/** What a new task sends. Its status is To do: the board adds new tasks there. */
export function newTask(form: TaskForm) {
  return {
    title: form.title.trim(),
    notes: form.notes.trim(),
    ownerTeammateId: form.ownerTeammateId,
    dueOn: form.dueOn,
  };
}

/** What saving the task screen sends, given the task it has saved so far (none yet when new). */
export type TaskWrite =
  | { kind: "create"; input: ReturnType<typeof newTask> }
  | { kind: "update"; taskId: string; changes: TaskChanges }
  | { kind: "none"; taskId: string };

/**
 * A task the screen hasn't saved yet is created; once it has an id (it was added here, then
 * starting it failed, say) it's only ever updated, so trying again never adds it twice.
 */
export function taskWrite(savedId: string | null, start: TaskForm, form: TaskForm): TaskWrite {
  if (!savedId) return { kind: "create", input: newTask(form) };
  const changes = taskChanges(start, form);
  return Object.keys(changes).length > 0
    ? { kind: "update", taskId: savedId, changes }
    : { kind: "none", taskId: savedId };
}

/** The task screen's form, and the task as it was when the form last matched it. */
export interface TaskDraft {
  /** What's sent is the difference from this. */
  start: TaskForm;
  form: TaskForm;
}

/**
 * The draft against a fresher copy of the task: what you haven't touched takes the task's new
 * value (a teammate reassigned it on the web, say), what you changed stays yours, and what's sent
 * is now the difference from the fresh copy. The same draft comes back when nothing changed.
 */
export function rebaseTaskForm(draft: TaskDraft, fresh: TaskForm): TaskDraft {
  if (!taskFormChanged(draft.start, fresh)) return draft;
  const touched = taskChanges(draft.start, draft.form);
  const form = { ...fresh };
  for (const key of Object.keys(touched) as (keyof TaskForm)[])
    (form as Record<keyof TaskForm, unknown>)[key] = draft.form[key];
  return { start: fresh, form };
}

/** Where the task screen goes once a save (and a start, if asked) has finished. */
export type AfterSave =
  | { kind: "stay" }
  | { kind: "back" }
  | { kind: "chat"; chatId: string }
  | { kind: "task"; taskId: string };

/**
 * Where to go after saving: back to where you came from, or to the chat the owner was asked in.
 * A start that failed leaves you on the task to try again, and a task added here then opens as
 * itself (its own screen reads it, has its Status and Delete, and says if it's deleted). A screen
 * you've left meanwhile (you went to a chat, say) goes nowhere, so it never takes another screen
 * with it.
 */
export function afterSave(outcome: {
  focused: boolean;
  /** The id of a task this screen just added; null when it was saved before. */
  created: string | null;
  then: "start" | undefined;
  /** The start's answer; null when it failed. */
  started?: { chatId: string | null } | null;
}): AfterSave {
  if (!outcome.focused) return { kind: "stay" };
  if (outcome.then !== "start") return { kind: "back" };
  if (outcome.started?.chatId) return { kind: "chat", chatId: outcome.started.chatId };
  if (outcome.started) return { kind: "back" };
  return outcome.created ? { kind: "task", taskId: outcome.created } : { kind: "stay" };
}

/**
 * What the task screen shows: the task (the last copy seen, while a read fails for another
 * reason), that it was deleted while open, or that there's no such task. Only the server saying
 * it's gone counts as deleted, never the board leaving it out.
 */
export function taskScreenState<T>(
  read: { data: T | undefined; error: unknown },
  seen: T | undefined,
  isGone: (error: unknown) => boolean,
):
  | { kind: "loading" }
  | { kind: "task"; task: T; gone: boolean }
  | { kind: "missing" }
  | {
      kind: "error";
    } {
  const gone = read.error !== null && read.error !== undefined && isGone(read.error);
  const task = gone ? seen : (read.data ?? seen);
  if (task) return { kind: "task", task, gone };
  if (gone) return { kind: "missing" };
  if (read.error) return { kind: "error" };
  return { kind: "loading" };
}

/** Who owns a task, by name: you, a teammate, or one who has left the team. */
export const ownerName = (owner: { name: string } | undefined, ownerTeammateId: string | null) =>
  owner?.name ?? (ownerTeammateId ? "Former teammate" : "You");

/**
 * What TalkBack reads for a task in a list: everything the row shows, since the row is read as
 * one control and the owner and due chips inside it aren't read on their own.
 */
export function taskRowLabel(
  task: Pick<TaskView, "title" | "status" | "dueOn">,
  owner: string,
  blocker: TaskBlocker | null,
  now = new Date(),
): string {
  const due = task.dueOn
    ? `${dueState(task, now) === "overdue" ? "Overdue, due" : "Due"} ${dueLabel(task.dueOn, now)}`
    : null;
  return [
    task.title,
    TASK_STATUS_LABELS[task.status],
    blocker ? TASK_BLOCKER_TEXT[blocker] : null,
    owner,
    due,
  ]
    .filter(Boolean)
    .join(", ");
}

/** The words on the button that hands a task to its teammate. */
export const startLabel = (name: string, asked: boolean) =>
  asked ? `Ask ${name} again` : `Ask ${name} to start`;

/**
 * What deleting a task means, for its confirmation. The board has no undo, and deleting a task a
 * teammate is working on doesn't stop that work, so the question says so.
 */
export function deleteQuestion(
  task: Pick<TaskView, "title" | "status" | "ownerTeammateId">,
  ownerName: string | null,
): { title: string; body: string } {
  const working = task.status === "doing" && task.ownerTeammateId && ownerName;
  return {
    title: "Delete this task?",
    body: [
      `“${task.title}” is removed from the board for you and every teammate.`,
      working ? `${ownerName} may still be working on it in their chat.` : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * The few open tasks Home shows: what waits on you, then what's overdue or due soonest, then
 * what's in progress, then the rest in board order.
 */
export function homeTasks(
  tasks: readonly TaskView[],
  blockerOf: (task: TaskView) => TaskBlocker | null,
  limit: number,
  now = new Date(),
): TaskView[] {
  const rank = (task: TaskView) =>
    waitsOnYou(blockerOf(task))
      ? 0
      : isOverdue(task, now)
        ? 1
        : task.dueOn !== null && daysUntil(task.dueOn, now) <= 1
          ? 2
          : task.status === "doing"
            ? 3
            : 4;
  return tasks
    .filter((task) => task.status !== "done")
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") ||
        Number(b.status === "doing") - Number(a.status === "doing") ||
        a.position - b.position,
    )
    .slice(0, limit);
}

/** A teammate's open tasks, in progress first, then in board order. */
export function teammateTasks(tasks: readonly TaskView[], teammateId: string): TaskView[] {
  return tasks
    .filter((task) => task.ownerTeammateId === teammateId && task.status !== "done")
    .sort(
      (a, b) =>
        Number(b.status === "doing") - Number(a.status === "doing") || a.position - b.position,
    );
}

/** One day in the due date picker's month. */
export interface CalendarDay {
  day: string;
  date: number;
  inMonth: boolean;
}

/**
 * The weeks of a month for a calendar, each seven days long, starting on `weekStart` (0 is
 * Sunday) and padded with the days of the months around it.
 */
export function calendarWeeks(year: number, month: number, weekStart = 1): CalendarDay[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const weeks: CalendarDay[][] = [];
  const cells = Math.ceil((lead + days) / 7) * 7;
  for (let index = 0; index < cells; index++) {
    const date = new Date(year, month, 1 - lead + index);
    if (index % 7 === 0) weeks.push([]);
    weeks.at(-1)!.push({
      day: formatDay(date),
      date: date.getDate(),
      inMonth: date.getMonth() === month,
    });
  }
  return weeks;
}

/** The short names of the week's days, in the calendar's order. */
export function weekdayNames(weekStart = 1): string[] {
  const names = ["S", "M", "T", "W", "T", "F", "S"];
  return names.map((_, index) => names[(index + weekStart) % 7]!);
}

/** The phone's first day of the week (expo-localization's 1 is Sunday) as 0 for Sunday. */
export const weekStartFrom = (firstWeekday: number | null | undefined) =>
  firstWeekday ? (firstWeekday - 1) % 7 : 1;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const monthTitle = (year: number, month: number) => `${MONTH_NAMES[month]} ${year}`;

/** The quick due days above the calendar, counted from `today` (the phone's, without one). */
export function dueShortcuts(
  today: string = formatDay(new Date()),
): { label: string; day: string }[] {
  const start = parseDay(today);
  const plus = (days: number) =>
    formatDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + days));
  return [
    { label: "Today", day: plus(0) },
    { label: "Tomorrow", day: plus(1) },
    { label: "In a week", day: plus(7) },
  ];
}

/** The month a due day is in, or this month without one. */
export function monthOf(day: string | null, now = new Date()): { year: number; month: number } {
  const date = day ? parseDay(day) : now;
  return { year: date.getFullYear(), month: date.getMonth() };
}
