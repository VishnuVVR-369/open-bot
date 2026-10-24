import { bots, chats, tasks, type TaskStatus } from "@open-bot/db";
import { and, asc, desc, eq, isNull, max, ne } from "drizzle-orm";
import { enqueueRun, publishApp, type Context } from "../context";

export class TaskError extends Error {}

type Task = typeof tasks.$inferSelect;

export interface TaskPatch {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  ownerBotId?: string | null;
  dueOn?: string | null;
  /** Where it goes in its column; the end when the status changes and this is left out. */
  position?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new TaskError("Give the task a title.");
  if (trimmed.length > 200) throw new TaskError("Keep the title under 200 characters.");
  return trimmed;
}

function checkNotes(notes: string): string {
  if (notes.length > 8000) throw new TaskError("Keep the notes under 8000 characters.");
  return notes.trim();
}

function checkDue(dueOn: string | null): string | null {
  if (dueOn === null || dueOn === "") return null;
  if (!DATE.test(dueOn) || Number.isNaN(Date.parse(dueOn)))
    throw new TaskError("Give the due date as YYYY-MM-DD.");
  return dueOn;
}

/** The team's task board: you and the teammates add tasks, own them and move them along. */
export class TaskService {
  constructor(private readonly ctx: Context) {}

  private async endOf(status: TaskStatus): Promise<number> {
    const [row] = await this.ctx.db
      .select({ value: max(tasks.position) })
      .from(tasks)
      .where(eq(tasks.status, status));
    return (row?.value ?? 0) + 1;
  }

  private async checkOwner(ownerBotId: string | null): Promise<string | null> {
    if (!ownerBotId) return null;
    const [bot] = await this.ctx.db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, ownerBotId), isNull(bots.archivedAt)));
    if (!bot) throw new TaskError("That teammate isn't on the team anymore.");
    return bot.id;
  }

  async create(input: {
    title: string;
    notes?: string;
    ownerBotId?: string | null;
    dueOn?: string | null;
    createdBy: "user" | "bot";
    createdByBotId?: string | null;
  }): Promise<Task> {
    const [row] = await this.ctx.db
      .insert(tasks)
      .values({
        title: checkTitle(input.title),
        notes: checkNotes(input.notes ?? ""),
        ownerBotId: await this.checkOwner(input.ownerBotId ?? null),
        dueOn: checkDue(input.dueOn ?? null),
        position: await this.endOf("todo"),
        createdBy: input.createdBy,
        createdByBotId: input.createdByBotId ?? null,
      })
      .returning();
    await publishApp(this.ctx, { type: "tasks" });
    return row!;
  }

  async get(id: string): Promise<Task | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.ctx.db.select().from(tasks).where(eq(tasks.id, id));
    return row ?? null;
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const existing = await this.get(id);
    if (!existing) throw new TaskError("That task no longer exists.");
    const status = patch.status ?? existing.status;
    const moved = status !== existing.status;
    const [row] = await this.ctx.db
      .update(tasks)
      .set({
        ...(patch.title !== undefined ? { title: checkTitle(patch.title) } : {}),
        ...(patch.notes !== undefined ? { notes: checkNotes(patch.notes) } : {}),
        ...(patch.ownerBotId !== undefined
          ? { ownerBotId: await this.checkOwner(patch.ownerBotId) }
          : {}),
        ...(patch.dueOn !== undefined ? { dueOn: checkDue(patch.dueOn) } : {}),
        status,
        position: patch.position ?? (moved ? await this.endOf(status) : existing.position),
        ...(moved ? { completedAt: status === "done" ? new Date() : null } : {}),
      })
      .where(eq(tasks.id, id))
      .returning();
    await publishApp(this.ctx, { type: "tasks" });
    return row!;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.db.delete(tasks).where(eq(tasks.id, id));
    await publishApp(this.ctx, { type: "tasks" });
  }

  /**
   * Asks the task's owner to work on it, in their latest chat, and moves it to Doing. The run
   * carries the task's id, so the owner can mark it done.
   */
  async start(id: string, by: { botName: string; runId: string } | null): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new TaskError("That task no longer exists.");
    if (!task.ownerBotId) throw new TaskError("Give the task to a teammate first.");
    if (task.status === "done") throw new TaskError("That task is already done.");
    const [chat] = await this.ctx.db
      .select({ id: chats.id })
      .from(chats)
      .where(
        and(eq(chats.botId, task.ownerBotId), eq(chats.kind, "direct"), isNull(chats.archivedAt)),
      )
      .orderBy(desc(chats.lastActivityAt))
      .limit(1);
    if (!chat) throw new TaskError("That teammate has no chat to work in.");
    const from = by ? `${by.botName} asked you` : "The user asked you";
    await enqueueRun(this.ctx, {
      chatId: chat.id,
      botId: task.ownerBotId,
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
    const [row] = await this.ctx.db
      .update(tasks)
      .set({
        status: "doing",
        chatId: chat.id,
        ...(task.status !== "doing" ? { position: await this.endOf("doing") } : {}),
      })
      .where(eq(tasks.id, task.id))
      .returning();
    await publishApp(this.ctx, { type: "tasks" });
    return row!;
  }

  /** The open tasks and the recently finished ones, as a bot reads them. */
  async describe(forBotId: string): Promise<string> {
    const rows = await this.ctx.db
      .select({ task: tasks, owner: bots.name })
      .from(tasks)
      .leftJoin(bots, eq(bots.id, tasks.ownerBotId))
      .where(ne(tasks.status, "done"))
      .orderBy(asc(tasks.status), asc(tasks.position));
    const done = await this.ctx.db
      .select({ task: tasks, owner: bots.name })
      .from(tasks)
      .leftJoin(bots, eq(bots.id, tasks.ownerBotId))
      .where(eq(tasks.status, "done"))
      .orderBy(desc(tasks.completedAt))
      .limit(10);
    const line = ({ task, owner }: { task: Task; owner: string | null }) =>
      `- [${task.status}] ${task.title} (id ${task.id}; ${
        task.ownerBotId === forBotId ? "yours" : owner ? `owner ${owner}` : "no owner"
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
