// Approvals: what a teammate asks before a risky action, and the rules that allow it next time.
// Code outside this folder imports only from here, or from `server.ts` for the server side.
export {
  ApprovalIcon,
  ApprovalReview,
  ApprovalTitle,
  NEEDS_YOU_SURFACE,
  RiskChip,
  riskOf,
  type ApprovalSubject,
} from "./components/approval-parts";
export { ApprovalsView } from "./components/approvals-view";
export { useApprovals } from "./hooks";
