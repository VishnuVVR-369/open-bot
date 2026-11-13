import { os } from "../../core/rpc";
import type { ApprovalService } from "./service";

const ok = { ok: true } as const;

/** Your decisions on approvals, and your "always allow" rules (`workerContract.approvals`). */
export function approvalRoutes(approvals: ApprovalService) {
  return {
    decide: os.approvals.decide.handler(({ input }) =>
      approvals.decideAsOwner(input.approvalId, input.decision, input.alwaysAllow),
    ),
    removeRule: os.approvals.removeRule.handler(async ({ input }) => {
      await approvals.removeRule(input.ruleId);
      return ok;
    }),
  };
}
