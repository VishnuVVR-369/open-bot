import { LOCKS, lockUntilCommit, teammates, tasks, type Tx } from "@open-bot/db";
import {
  placeTask,
  TASK_NOTES_MAX,
  TASK_TITLE_MAX,
  type Creator,
  type TaskPlacement,
  type TaskStatus,
} from "@open-bot/domain";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { WorkerError } from "../../core/errors";
import { announceRun, insertRun } from "../../runs/queue";
import { mainChat } from "../chat";

export class TaskError extends WorkerError {
  constructor(message: string) {
    super(400, message);
  }
}

type Task = typeof tasks.$inferSelect;

export interface TaskPatch {
  title?: string;
  notes?: string;
  /** A new column puts it at the end there. */
  status?: TaskStatus;
  ownerTeammateId?: string | null;
  dueOn?: string | null;
  /**
   * Deprecated: where a web app from before `move` dropped it. It goes before the first task past
   * this position in its column.
   */
  position?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new TaskError("Give the task a title.");
  if (trimmed.length > TASK_TITLE_MAX)
    throw new TaskError(`Keep the title under ${TASK_TITLE_MAX} characters.`);
  return trimmed;
}

function checkNotes(notes: string): string {
  if (notes.length > TASK_NOTES_MAX)
    throw new TaskError(`Keep the notes under ${TASK_NOTES_MAX} characters.`);
  return notes.trim();
}

function checkDue(dueOn: string | null): string | null {
  if (dueOn === null || dueOn === "") return null;
  if (!DATE.test(dueOn) || Number.isNaN(Date.parse(dueOn)))
    throw new TaskError("Give the due date as YYYY-MM-DD.");
  return dueOn;
}

/** When it was finished, for a task that changes column. */
const completedAt = (from: TaskStatus, to: TaskStatus) =>
  from === to ? {} : { completedAt: to === "done" ? new Date() : null };

/** The placement a web app from before `move` meant by a raw position. */
function placementAt(
  column: readonly { id: string; position: number }[],
  id: string,
  position: number,
): TaskPlacement {
  const next = column
    .filter((task) => task.id !== id && task.position > position)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0];
  return next ? { kind: "before", taskId: next.id } : { kind: "end" };
}

/** The team's task board: you and the teammates add tasks, own them and move them along. */
export class TaskService {
  constructor(private readonly ctx: Context) {}

  /**
   * Runs `write` holding the board's order: every write that sets a task's column or place goes
   * through here, so two at once never read the same neighbours and share a place.
   */
  private onBoard<T>(write: (tx: Tx) => Promise<T>): Promise<T> {
    return this.ctx.db.transaction(async (tx) => {
      await lockUntilCommit(tx, LOCKS.taskBoard);
      return write(tx);
    });
  }

  /** The task, locked until the transaction ends. */
  private async lockTask(tx: Tx, id: string): Promise<Task> {
    const [row] = /^[0-9a-f-]{36}$/i.test(id)
      ? await tx.select().from(tasks).where(eq(tasks.id, id)).for("update")
      : [];
    if (!row) throw new TaskError("That task no longer exists.");
    return row;
  }

  /**
   * The task's position at `placement` in the `status` column, against every task there. When its
   * neighbours leave no room, the rest of the column is numbered again here, in the same
   * transaction.
   */
  private async place(
    tx: Tx,
    id: string,
    status: TaskStatus,
    placement: TaskPlacement | ((column: { id: string; position: number }[]) => TaskPlacement),
  ): Promise<number> {
    const column = await tx
      .select({ id: tasks.id, position: tasks.position })
      .from(tasks)
      .where(eq(tasks.status, status));
    const changes = placeTask(
      column,
      id,
      typeof placement === "function" ? placement(column) : placement,
    );
    if (!changes)
      throw new TaskError("The task it was moved next to isn't in that column anymore.");
    const [own, ...others] = changes;
    for (const change of others)
      await tx.update(tasks).set({ position: change.position }).where(eq(tasks.id, change.id));
    return own!.position;
  }

  private async checkOwner(ownerTeammateId: string | null): Promise<string | null> {
    if (!ownerTeammateId) return null;
    const [teammate] = await this.ctx.db
      .select({ id: teammates.id })
      .from(teammates)
      .where(and(eq(teammates.id, ownerTeammateId), isNull(teammates.archivedAt)));
    if (!teammate) throw new TaskError("That teammate isn't on the team anymore.");
    return teammate.id;
  }

  async create(input: {
    title: string;
    notes?: string;
    ownerTeammateId?: string | null;
    dueOn?: string | null;
    createdBy: Creator;
    createdByTeammateId?: string | null;
  }): Promise<Task> {
    const values = {
      title: checkTitle(input.title),
      notes: checkNotes(input.notes ?? ""),
      ownerTeammateId: await this.checkOwner(input.ownerTeammateId ?? null),
      dueOn: checkDue(input.dueOn ?? null),
      createdBy: input.createdBy,
      createdByTeammateId: input.createdByTeammateId ?? null,
    };
    const row = await this.onBoard(async (tx) => {
      // A task not on the board yet: the end never needs the column numbered again.
      const position = await this.place(tx, "", "todo", { kind: "end" });
      const [row] = await tx
        .insert(tasks)
        .values({ ...values, position })
        .returning();
      return row!;
    });
    await publishApp(this.ctx, { type: "tasks" });
    return row;
  }

  async get(id: string): Promise<Task | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.ctx.db.select().from(tasks).where(eq(tasks.id, id));
    return row ?? null;
  }

  /**
   * Changes what's given and keeps the rest. A new column puts it at the end there. A new owner
   * hasn't been asked to work on it, so the chat the last owner was asked in goes.
   */
  async update(id: string, patch: TaskPatch): Promise<Task> {
    const fields = {
      ...(patch.title !== undefined ? { title: checkTitle(patch.title) } : {}),
      ...(patch.notes !== undefined ? { notes: checkNotes(patch.notes) } : {}),
      ...(patch.ownerTeammateId !== undefined
        ? { ownerTeammateId: await this.checkOwner(patch.ownerTeammateId) }
        : {}),
      ...(patch.dueOn !== undefined ? { dueOn: checkDue(patch.dueOn) } : {}),
    };
    const row = await this.onBoard(async (tx) => {
      const task = await this.lockTask(tx, id);
      const status = patch.status ?? task.status;
      const position =
        patch.position !== undefined
          ? await this.place(tx, id, status, (column) => placementAt(column, id, patch.position!))
          : status !== task.status
            ? await this.place(tx, id, status, { kind: "end" })
            : undefined;
      const reassigned =
        fields.ownerTeammateId !== undefined && fields.ownerTeammateId !== task.ownerTeammateId;
      const [row] = await tx
        .update(tasks)
        .set({
          ...fields,
          status,
          ...completedAt(task.status, status),
          ...(position !== undefined ? { position } : {}),
          ...(reassigned ? { chatId: null } : {}),
        })
        .where(eq(tasks.id, id))
        .returning();
      return row!;
    });
    await publishApp(this.ctx, { type: "tasks" });
    return row;
  }

  /**
   * Moves a task to a column, at its end or next to a task there, in one change: its position is
   * worked out here against the whole column, so a filter on the board or a stale copy can't put it
   * on top of another task.
   */
  async move(id: string, status: TaskStatus, placement: TaskPlacement): Promise<Task> {
    const row = await this.onBoard(async (tx) => {
      const task = await this.lockTask(tx, id);
      const position = await this.place(tx, id, status, placement);
      const [row] = await tx
        .update(tasks)
        .set({ status, position, ...completedAt(task.status, status) })
        .where(eq(tasks.id, id))
        .returning();
      return row!;
    });
    await publishApp(this.ctx, { type: "tasks" });
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.db.delete(tasks).where(eq(tasks.id, id));
    await publishApp(this.ctx, { type: "tasks" });
  }

  /**
   * Asks the task's owner to work on it, in their main chat, and moves it to Doing. The run
   * carries the task's id, so the owner can mark it done. The run and the task change are saved
   * together, so a failed start queues nothing and trying again asks once.
   */
  async start(id: string, by: { teammateName: string; runId: string } | null): Promise<Task> {
    const seen = await this.get(id);
    if (!seen) throw new TaskError("That task no longer exists.");
    const ownerTeammateId = seen.ownerTeammateId;
    if (!ownerTeammateId) throw new TaskError("Give the task to a teammate first.");
    if (seen.status === "done") throw new TaskError("That task is already done.");
    // Finding or making the main chat is its own change, and trying again finds the same one.
    const chatId = await mainChat(this.ctx, ownerTeammateId);
    const from = by ? `${by.teammateName} asked you` : "The user asked you";
    const row = await this.onBoard(async (tx) => {
      const task = await this.lockTask(tx, id);
      if (task.ownerTeammateId !== ownerTeammateId)
        throw new TaskError("That task was just given to someone else. Try again.");
      if (task.status === "done") throw new TaskError("That task is already done.");
      await insertRun(tx, {
        chatId,
        teammateId: ownerTeammateId,
        trigger: "task",
        prompt: [
          `[${from} to work on a task from the team's board (task id ${task.id}). When it's finished, mark it done with update_task, and say what you did.]`,
          `Task: ${task.title}`,
          task.dueOn ? `Due: ${task.dueOn}` : null,
          task.notes ? `Notes:\n${task.notes}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        parentRunId: by?.runId ?? null,
      });
      const position =
        task.status !== "doing" ? await this.place(tx, id, "doing", { kind: "end" }) : undefined;
      const [row] = await tx
        .update(tasks)
        .set({ status: "doing", chatId, ...(position !== undefined ? { position } : {}) })
        .where(eq(tasks.id, id))
        .returning();
      return row!;
    });
    await announceRun(this.ctx, chatId);
    await publishApp(this.ctx, { type: "tasks" });
    return row;
  }

  /** The open tasks and the recently finished ones, as a teammate reads them. */
  async describe(forTeammateId: string): Promise<string> {
    const rows = await this.ctx.db
      .select({ task: tasks, owner: teammates.name })
      .from(tasks)
      .leftJoin(teammates, eq(teammates.id, tasks.ownerTeammateId))
      .where(ne(tasks.status, "done"))
      .orderBy(asc(tasks.status), asc(tasks.position), asc(tasks.id));
    const done = await this.ctx.db
      .select({ task: tasks, owner: teammates.name })
      .from(tasks)
      .leftJoin(teammates, eq(teammates.id, tasks.ownerTeammateId))
      .where(eq(tasks.status, "done"))
      .orderBy(desc(tasks.completedAt))
      .limit(10);
    const line = ({ task, owner }: { task: Task; owner: string | null }) =>
      `- [${task.status}] ${task.title} (id ${task.id}; ${
        task.ownerTeammateId === forTeammateId ? "yours" : owner ? `owner ${owner}` : "no owner"
      }${task.dueOn ? `; due ${task.dueOn}` : ""})${task.notes ? `\n  ${task.notes.replace(/\n/g, "\n  ")}` : ""}`;
    if (rows.length === 0 && done.length === 0) return "The board is empty.";
    return [
      rows.length ? `Open tasks:\n${rows.map(line).join("\n")}` : "No open tasks.",
      done.length ? `Recently done:\n${done.map(line).join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
