import "server-only";
import type { TaskMoveInput } from "@open-bot/api";
import { ApiError } from "@/lib/server/api/errors";
import { isMissingRoute, worker } from "@/lib/server/worker";

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
