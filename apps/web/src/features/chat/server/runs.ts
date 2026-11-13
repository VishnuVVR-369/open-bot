import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "@/lib/server/worker";
import { reusedId } from "./chats";

/** Your requests about runs. The worker makes them (it owns runs, see packages/db/src/owners.ts). */

type Inputs = ApiInputs["runs"];

/** Run a failed or stopped request again; asking twice finds the first retry. */
export async function retryRun({ runId }: Inputs["retry"]): Promise<{ runId: string }> {
  return worker.runs.retry({ runId });
}

export function cancelRun({ runId }: Inputs["cancel"]) {
  return worker.runs.stop({ runId });
}

export function rateRun({ runId, rating }: Inputs["rate"]) {
  return worker.runs.rate({ runId, rating });
}

/**
 * A thumbs down with what to change, kept as a lesson and, with `redo`, sent to the chat so the
 * teammate tries again now. Retrying the same feedback is safe.
 */
export async function giveFeedback(input: Inputs["feedback"]) {
  await reusedId(worker.runs.feedback(input));
  return { ok: true as const };
}

export async function stopSwarm({ swarmId }: ApiInputs["swarms"]["stop"]) {
  await worker.swarms.stop({ swarmId });
  return { ok: true as const };
}
