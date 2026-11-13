import "server-only";
import { os } from "@/lib/server/api/rpc";
import {
  decideApproval,
  getApproval,
  listApprovalRules,
  listApprovals,
  removeApprovalRule,
} from "./service";

/** Approvals and the rules that skip them, as the browser and the phone ask (`contract.approvals`). */
export function approvalRoutes() {
  return {
    list: os.approvals.list.handler(() => listApprovals()),
    get: os.approvals.get.handler(({ input }) => getApproval(input.approvalId)),
    decide: os.approvals.decide.handler(({ input }) => decideApproval(input)),
    rules: os.approvals.rules.handler(() => listApprovalRules()),
    removeRule: os.approvals.removeRule.handler(({ input }) => removeApprovalRule(input)),
  };
}
