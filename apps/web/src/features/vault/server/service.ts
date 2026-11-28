import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { ApiError } from "@/lib/server/api/errors";
import { FINISHING_UPDATE, isMissingRoute, worker } from "@/lib/server/worker";

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
