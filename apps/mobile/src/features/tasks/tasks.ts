import type { TaskView } from "@open-bot/api";
import {
  daysUntil,
  dueLabel,
  dueState,
  endPosition,
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

/**
 * The board with a task the worker just added, as the worker placed it (at the end of To do), so
 * it shows at once: the task screen opens on it before the board comes back from the server.
 */
export function withAddedTask(
  board: readonly TaskView[],
  id: string,
  form: TaskForm,
  now = new Date(),
): TaskView[] {
  if (board.some((task) => task.id === id)) return [...board];
  const added: TaskView = {
    id,
    ...newTask(form),
    status: "todo",
    position: endPosition(board.filter((task) => task.status === "todo")),
    createdBy: "user",
    createdByTeammateId: null,
    chatId: null,
    completedAt: null,
    createdAt: now.toISOString(),
  };
  return [...board, added];
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
export const startLabel = (status: TaskStatus, name: string) =>
  status === "doing" ? `Ask ${name} again` : `Ask ${name} to start`;

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

/** The quick due days above the calendar. */
export function dueShortcuts(now = new Date()): { label: string; day: string }[] {
  const plus = (days: number) =>
    formatDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
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
