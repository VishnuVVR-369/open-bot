import { approvalDecisionSchema, approvalStatusSchema } from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import { approvalRuleSchema, approvalViewSchema } from "../views";

export const decideApprovalInputSchema = z.object({
  approvalId: id,
  decision: approvalDecisionSchema,
  /** Approve, and stop asking about what this pattern matches. */
  alwaysAllow: z.object({ pattern: z.string().max(300) }).nullable(),
});

export const approvalsContract = {
  /** Pending approvals first, then recent decisions. */
  list: base.output(z.array(approvalViewSchema)),
  get: base.input(z.object({ approvalId: id })).output(approvalViewSchema),
  /**
   * Approve or deny. Deciding again the same way succeeds; if it was decided differently
   * elsewhere, or expired, it fails with `ALREADY_DECIDED` and how it ended.
   */
  decide: base.input(decideApprovalInputSchema).output(z.object({ status: approvalStatusSchema })),
  /** What each teammate may do without asking. */
  rules: base.output(z.array(approvalRuleSchema)),
  /** Make a teammate ask about this again. */
  removeRule: base.input(z.object({ ruleId: id })).output(ok),
};
