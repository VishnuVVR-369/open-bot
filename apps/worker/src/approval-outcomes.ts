// What approval decisions move along elsewhere, for ApprovalService: the purchases and account
// actions they were asked about. Kept outside the approvals feature, which takes it as an
// argument, so approvals don't import what they decide and those don't import approvals back.
import { decideAccountAction } from "./features/integrations";
import type { ApprovalOutcomes } from "./features/approvals";
import { askAboutPurchase, decidePurchase } from "./features/vault";

export const APPROVAL_OUTCOMES: ApprovalOutcomes = {
  askAboutPurchase,
  decidePurchase,
  decideAccountAction,
};
