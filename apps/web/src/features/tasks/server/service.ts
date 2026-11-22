import "server-only";
import type { TaskMoveInput } from "@open-bot/api";
import { tasks } from "@open-bot/db";
import { placeTask } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { ApiError } from "@/lib/server/api/errors";
import { db } from "@/lib/server/db";
import { worker, WorkerError } from "@/lib/server/worker";

/**
 * The worker has no such route: it's from before that route, still running while a deploy
 * finishes (the web app and the worker deploy on their own, in either order). A worker answers
 * a path it doesn't know with this 404, never a feature's refusal.
 */
export const isMissingRoute = (error: unknown) =>
  error instanceof WorkerError && error.status === 404 && error.message === "not found";

/**
 * Moves a task with the worker's `move`, which places it against the whole column under the
 * board's lock. A worker from before `move` answers 404; then the task is placed here and sent the
 * way web apps before `move` did, as `update` with a position, so a drag works all through a
 * deploy. That worker writes the position as given, so the tasks a tie renumbers are sent first.
 */
export async function moveTask(input: TaskMoveInput): Promise<{ ok: true }> {
  try {
    return await worker.tasks.move(input);
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
  }
  const column = await db
    .select({ id: tasks.id, position: tasks.position })
    .from(tasks)
    .where(eq(tasks.status, input.status));
  const changes = placeTask(column, input.taskId, input.placement);
  if (!changes)
    throw new ApiError(
      "BAD_REQUEST",
      "The task it was moved next to isn't in that column anymore.",
    );
  const [own, ...others] = changes;
  for (const change of others)
    await worker.tasks.update({ taskId: change.id, position: change.position });
  return worker.tasks.update({
    taskId: input.taskId,
    status: input.status,
    position: own!.position,
  });
}
