import { base, id, ok } from "../base";
import { approvalStatusSchema } from "@open-bot/domain";
import { z } from "zod";
import { decideApprovalInputSchema } from "../../contracts/approvals";

export const approvalsContract = {
  /** Says how the approval ended, also when it was decided elsewhere first or expired. */
  decide: base
    .route({ method: "POST", path: "/internal/approvals/{approvalId}/decide" })
    .input(decideApprovalInputSchema.partial({ alwaysAllow: true }))
    .output(z.object({ decided: z.boolean(), status: approvalStatusSchema })),
  removeRule: base
    .route({ method: "POST", path: "/internal/approval-rules/{ruleId}/delete" })
    .input(z.object({ ruleId: id }))
    .output(ok),
};
