import type { AccountApprovalKind, ActionEffect } from "@open-bot/domain";

/**
 * How an action reaches the world decides whether it asks you first. Each integration's adapter
 * works the effect out from the tool and its checked arguments, never from what the teammate says
 * about it, and calls it outward when it can't be established. This turns it into asking you.
 */

/**
 * Whether an action on one of your accounts asks you first, and as which kind.
 *
 * - Private writes (drafts, labels) only you see: they run, except for a teammate that asks
 *   about everything.
 * - Writes (your own calendar, your teammates' Notion pages) follow the teammate's autonomy, and
 *   "Always allow" rules per tool.
 * - Outward actions (sending, inviting, pages others see) always ask, unless the teammate works
 *   fully on its own, you turned "Always ask before acting for me" off, and the run hasn't read
 *   anything from outside, which could have told it to.
 */
export function approvalFor(input: {
  effect: ActionEffect;
  autonomy: string;
  askBeforeActing: boolean;
  readOutsideData: boolean;
  coveredByRule: boolean;
}): AccountApprovalKind | null {
  const { effect, autonomy } = input;
  if (effect === "read") return null;
  if (effect === "private_write") return autonomy === "everything" ? "account_write" : null;
  if (effect === "write") {
    if (autonomy === "full") return null;
    if (autonomy === "everything") return "account_write";
    return input.coveredByRule ? null : "account_write";
  }
  if (autonomy === "full" && !input.askBeforeActing && !input.readOutsideData) return null;
  return "account_outward";
}
