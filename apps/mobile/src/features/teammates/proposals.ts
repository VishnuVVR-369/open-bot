import type { PendingProposalView } from "@open-bot/api";
import { isGone } from "../../lib/errors";

/** How a teammate's suggested instructions are decided on the phone. */

/**
 * After the server refused a decision as a conflict, what the card does once it has read the
 * suggestion waiting again (`read`, as `safe` answers). The same suggestion still waiting means
 * what changed is the instructions: the card stays, showing the change against them now, so you
 * review it again. Anything else settled it: another suggestion, none, or a teammate that's gone
 * (archived, so nothing waits for it). A read that failed otherwise keeps the card.
 */
export function afterConflict(
  proposalId: string,
  read: { error: unknown; data?: PendingProposalView | null },
): "review-again" | "settled" {
  if (read.error) return isGone(read.error) ? "settled" : "review-again";
  return read.data?.id === proposalId ? "review-again" : "settled";
}
