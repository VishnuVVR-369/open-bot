// Approvals: asking you before a consequential action, your decisions, and "always allow" rules.
// Code outside this folder imports only from here.
export { approvalRoutes } from "./routes";
export {
  addApprovalRules,
  ApprovalService,
  expireApprovals,
  type ApprovalOutcomes,
} from "./service";
export { APPROVAL_TOOLS } from "./tools";
