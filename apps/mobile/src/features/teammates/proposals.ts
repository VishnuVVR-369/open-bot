import type { PendingProposalView } from "@open-bot/api";

/** How a teammate's suggested instructions are decided on the phone. */

/**
 * After the server refused a decision as a conflict, what the card does once it has read the
 * suggestion waiting again (`fresh`, or `undefined` when that read failed). The same suggestion
 * still waiting means what changed is the instructions: the card stays, showing the change against
 * them now, so you review it again. Anything else (another suggestion, or none) settled it.
 */
export function afterConflict(
  proposalId: string,
  fresh: PendingProposalView | null | undefined,
): "review-again" | "settled" {
  if (fresh === undefined) return "review-again";
  return fresh?.id === proposalId ? "review-again" : "settled";
}
