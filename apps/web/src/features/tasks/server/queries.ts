import "server-only";
import { tasks } from "@open-bot/db";
import { asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { TaskView } from "@/lib/types";

/** Open tasks, and the 30 most recently finished. */
export async function listTasks(): Promise<TaskView[]> {
  const [open, done] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(ne(tasks.status, "done"))
      .orderBy(asc(tasks.position), asc(tasks.id)),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "done"))
      .orderBy(desc(tasks.completedAt))
      .limit(30),
  ]);
  return [...open, ...done].map(taskView);
}

/** One task, whatever its column, or null when there's no such task. */
export async function getTask(id: string): Promise<TaskView | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  return task ? taskView(task) : null;
}

function taskView(task: typeof tasks.$inferSelect): TaskView {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    ownerTeammateId: task.ownerTeammateId,
    dueOn: task.dueOn,
    position: task.position,
    createdBy: task.createdBy,
    createdByTeammateId: task.createdByTeammateId,
    chatId: task.chatId,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
  };
}
