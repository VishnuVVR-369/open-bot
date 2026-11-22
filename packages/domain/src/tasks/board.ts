import { STATUS } from "../teammates/status";
import { TASK_STATUSES, type TaskStatus } from "./tasks";

/**
 * How the team's board is laid out, the same on the web and the phone: which column a task is
 * in, the order inside it, what holds a task up and how its due day reads.
 */

/** Each status's name on the board. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

/** The longest title and notes a task takes, as the worker enforces them. */
export const TASK_TITLE_MAX = 200;
export const TASK_NOTES_MAX = 8000;

/** How many finished tasks show before "Show N more completed". */
export const DONE_SHOWN = 4;

/** What the board needs of a task. */
export interface BoardTask {
  id: string;
  status: TaskStatus;
  position: number;
  ownerTeammateId: string | null;
  dueOn: string | null;
  chatId: string | null;
  completedAt: string | null;
}

/**
 * What holds a task up: you (an approval, a take over), or the computer being offline while a
 * teammate is on it.
 */
export type TaskBlocker = "approval" | "takeover" | "paused";

export const TASK_BLOCKER_TEXT: Record<TaskBlocker, string> = {
  approval: "Waiting for approval",
  takeover: "Waiting for you to take over",
  paused: STATUS.paused,
};

/** What the board knows about the rest of the app when it says what holds a task up. */
export interface BlockerFacts {
  /** Chats with an approval waiting on you. */
  approvalChatIds: ReadonlySet<string>;
  /** Chats with a take over request waiting on you. */
  takeoverChatIds: ReadonlySet<string>;
  /** Whether the computer is online; unknown counts as online. */
  online: boolean;
}

/** What holds the task up, if anything. A finished task has nothing holding it. */
export function taskBlocker(task: BoardTask, facts: BlockerFacts): TaskBlocker | null {
  if (task.status === "done") return null;
  if (task.chatId) {
    if (facts.approvalChatIds.has(task.chatId)) return "approval";
    if (facts.takeoverChatIds.has(task.chatId)) return "takeover";
  }
  // A teammate's task in progress can't move while the computer is offline.
  if (!facts.online && task.status === "doing" && task.ownerTeammateId) return "paused";
  return null;
}

/** A blocker that waits on you, rather than on the computer. */
export function waitsOnYou(blocker: TaskBlocker | null): boolean {
  return blocker === "approval" || blocker === "takeover";
}

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A `YYYY-MM-DD` day as local midnight. */
export function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!);
}

/** A local date as `YYYY-MM-DD`. */
export function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar days from today to `day`: 0 today, 1 tomorrow, -1 yesterday. */
export function daysUntil(day: string, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounded, so a day that is 23 or 25 hours long (a clock change) still counts as one.
  return Math.round((parseDay(day).getTime() - today.getTime()) / DAY);
}

/** "Today", "Tomorrow", "Yesterday", "Jan 15", or "Jan 15, 2030" in another year. */
export function dueLabel(day: string, now: Date = new Date()): string {
  const days = daysUntil(day, now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const date = parseDay(day);
  const short = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? short : `${short}, ${date.getFullYear()}`;
}

/** How a due day stands: past it, today, or later (or the task is done, so it doesn't matter). */
export type DueState = "overdue" | "today" | "later";

export function dueState(task: Pick<BoardTask, "dueOn" | "status">, now = new Date()): DueState {
  if (!task.dueOn || task.status === "done") return "later";
  const days = daysUntil(task.dueOn, now);
  return days < 0 ? "overdue" : days === 0 ? "today" : "later";
}

export function isOverdue(task: Pick<BoardTask, "dueOn" | "status">, now = new Date()): boolean {
  return dueState(task, now) === "overdue";
}

/** Which tasks the board shows: every task, yours, or the ones waiting on you or overdue. */
export type TaskFilter = "all" | "mine" | "attention";

/** Tasks without a teammate are yours. */
export const isMine = (task: Pick<BoardTask, "ownerTeammateId">) => task.ownerTeammateId === null;

export interface BoardColumn<T extends BoardTask> {
  status: TaskStatus;
  tasks: T[];
}

/**
 * The board's columns for a filter, each in board order: what waits on you leads, then by
 * position; finished tasks most recent first.
 */
export function boardColumns<T extends BoardTask>(
  tasks: readonly T[],
  blockerOf: (task: T) => TaskBlocker | null,
  filter: TaskFilter = "all",
  now = new Date(),
): BoardColumn<T>[] {
  const shown = tasks.filter((task) =>
    filter === "mine"
      ? isMine(task)
      : filter === "attention"
        ? waitsOnYou(blockerOf(task)) || isOverdue(task, now)
        : true,
  );
  return TASK_STATUSES.map((status) => ({
    status,
    tasks: shown
      .filter((task) => task.status === status)
      .sort((a, b) => {
        if (status === "done") return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
        const first = Number(waitsOnYou(blockerOf(b))) - Number(waitsOnYou(blockerOf(a)));
        // Tasks that share a position keep one order, wherever the list came from.
        return first || a.position - b.position || a.id.localeCompare(b.id);
      }),
  }));
}

/** The counts beside the filters: your open tasks, and everything that needs you. */
export function filterCounts<T extends BoardTask>(
  tasks: readonly T[],
  blockerOf: (task: T) => TaskBlocker | null,
  now = new Date(),
): { mine: number; attention: number } {
  return {
    mine: tasks.filter((task) => task.status !== "done" && isMine(task)).length,
    attention: tasks.filter((task) => waitsOnYou(blockerOf(task)) || isOverdue(task, now)).length,
  };
}

/** The position that puts a task at the end of a column. */
export function endPosition(column: readonly Pick<BoardTask, "id" | "position">[], id?: string) {
  const others = column.filter((task) => task.id !== id);
  return others.length ? Math.max(...others.map((task) => task.position)) + 1 : 1;
}

/** A task's new place in its column. */
export interface PositionChange {
  id: string;
  position: number;
}

/**
 * Moves a task one place up or down in its column as the board draws it (`drawn`, from
 * `boardColumns` with the filter in use), among the tasks that share its standing: what waits on
 * you is always drawn first, so a task only trades places with one on the same side of that line.
 * Hidden tasks don't count, so every move shows.
 *
 * The task lands halfway between its new neighbours, or one past the end. When they share a
 * position (two tasks added at once, or halved too often) there is no room between them, so the
 * group is numbered again in its new order. Null when it can't move that way.
 */
export function stepTask<T extends BoardTask>(
  drawn: readonly T[],
  id: string,
  direction: "up" | "down",
  blockerOf: (task: T) => TaskBlocker | null,
): PositionChange[] | null {
  const task = drawn.find((entry) => entry.id === id);
  if (!task || task.status === "done") return null;
  const standing = waitsOnYou(blockerOf(task));
  const group = drawn.filter((entry) => waitsOnYou(blockerOf(entry)) === standing);
  const from = group.indexOf(task);
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= group.length) return null;
  const order = [...group];
  order.splice(from, 1);
  order.splice(to, 0, task);
  const before = order[to - 1]?.position;
  const after = order[to + 1]?.position;
  const position =
    before === undefined ? after! - 1 : after === undefined ? before + 1 : (before + after) / 2;
  if ((before === undefined || position > before) && (after === undefined || position < after))
    return [{ id, position }];
  const start = Math.min(...group.map((entry) => entry.position));
  return order
    .map((entry, index) => ({ id: entry.id, position: start + index, was: entry.position }))
    .filter((change) => change.position !== change.was)
    .map(({ id, position }) => ({ id, position }));
}
