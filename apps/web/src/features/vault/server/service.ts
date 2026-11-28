import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { ApiError } from "@/lib/server/api/errors";
import { FINISHING_UPDATE, isMissingRoute, worker, WorkerError } from "@/lib/server/worker";

/**
 * Add a login or card under the client's id, so a retry finds the one it made. The worker's 409
 * is an id already used for a different item (`CONFLICT`). A worker from before `create`, for the
 * minute a deploy takes, can't: the web refuses with nothing changed rather than falling back to
 * a save that a retry could repeat.
 */
export async function createVaultItem(
  input: ApiInputs["vault"]["create"],
): Promise<ApiOutputs["vault"]["create"]> {
  try {
    return await worker.vault.create(input);
  } catch (error) {
    if (isMissingRoute(error)) throw new ApiError("BAD_REQUEST", FINISHING_UPDATE);
    if (error instanceof WorkerError && error.status === 409)
      throw new ApiError("CONFLICT", error.message);
    throw error;
  }
}

/**
 * Change only the given fields of a login or card (the edits on the web and the phone). A worker
 * from before `patch`, for the minute a deploy takes, can't; sending the whole item instead could
 * undo an edit made meanwhile, so it's refused with nothing changed.
 */
export async function patchVaultItem(
  input: ApiInputs["vault"]["patch"],
): Promise<ApiOutputs["vault"]["patch"]> {
  try {
    return await worker.vault.patch(input);
  } catch (error) {
    if (isMissingRoute(error)) throw new ApiError("BAD_REQUEST", FINISHING_UPDATE);
    throw error;
  }
}
