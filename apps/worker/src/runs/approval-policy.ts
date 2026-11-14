import type { v2 } from "@open-bot/agent";
import type { Autonomy } from "@open-bot/domain";

/**
 * When Codex itself asks before a command. "everything" asks about each one. The others ask only
 * when Codex judges a command dangerous (like `rm -f`); with "never" it would refuse those
 * outright, even after you approved them through request_approval.
 */
export function approvalPolicy(teammate: { autonomy: Autonomy }): v2.AskForApproval {
  return teammate.autonomy === "everything" ? "untrusted" : "on-request";
}
