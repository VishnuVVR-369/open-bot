import "server-only";
import { tasks } from "@open-bot/db";
import { asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { TaskView } from "@/lib/types";

/** Open tasks, and the 30 most recently finished. */
export async function listTasks(): Promise<TaskView[]> {
  const [open, done] = await Promise.all([
    db.select().from(tasks).where(ne(tasks.status, "done")).orderBy(asc(tasks.position)),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "done"))
      .orderBy(desc(tasks.completedAt))
      .limit(30),
  ]);
  return [...open, ...done].map((task) => ({
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    ownerBotId: task.ownerBotId,
    dueOn: task.dueOn,
    position: task.position,
    createdBy: task.createdBy,
    createdByBotId: task.createdByBotId,
    chatId: task.chatId,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
  }));
}
