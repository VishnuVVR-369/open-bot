import "server-only";
import type { TaskMoveInput } from "@open-bot/api";
import { ApiError } from "@/lib/server/api/errors";
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
 * board's lock, in one transaction. A worker from before `move` (for the minute a deploy takes)
 * can't do that, and placing it here with several `update`s would race the teammates' own writes,
 * so the move is refused with nothing changed and the owner tries again.
 */
export async function moveTask(input: TaskMoveInput): Promise<{ ok: true }> {
  try {
    return await worker.tasks.move(input);
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
    throw new ApiError(
      "BAD_REQUEST",
      "open-bot is finishing an update, so nothing moved. Try again in a minute.",
    );
  }
}
