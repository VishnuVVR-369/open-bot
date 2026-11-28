import { formatMoney, type PurchaseStatus } from "./vault";

/**
 * A teammate's monthly budget as the web's Spending tab and the phone's budget screen edit it, so
 * both say the same things and send the same values.
 */

/** A budget as it's saved, in cents: null means the teammate can't pay at all. */
export interface SavedBudget {
  budgetCents: number | null;
  autoApproveCents: number;
}

/** The budget form: whether the teammate can pay, and the amounts in dollars as typed. */
export interface BudgetForm {
  enabled: boolean;
  budget: string;
  autoApprove: string;
}

/** "42.5" from 4250 cents, or empty for none. */
export function dollarsText(cents: number | null): string {
  if (cents === null || cents === 0) return "";
  return String(cents / 100);
}

/** A dollar amount as you type it: digits and one point. */
export function moneyInput(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, "");
  const point = cleaned.indexOf(".");
  return point === -1
    ? cleaned
    : `${cleaned.slice(0, point + 1)}${cleaned.slice(point + 1).replace(/\./g, "")}`;
}

export function budgetForm(saved: SavedBudget): BudgetForm {
  return {
    enabled: saved.budgetCents !== null,
    budget: dollarsText(saved.budgetCents),
    autoApprove: dollarsText(saved.autoApproveCents),
  };
}

type BudgetField = keyof BudgetForm;

function changedBudgetFields(start: BudgetForm, form: BudgetForm): BudgetField[] {
  const fields: BudgetField[] = [];
  if (start.enabled !== form.enabled) fields.push("enabled");
  if (Number(start.budget || 0) !== Number(form.budget || 0)) fields.push("budget");
  if (Number(start.autoApprove || 0) !== Number(form.autoApprove || 0)) fields.push("autoApprove");
  return fields;
}

/**
 * Whether saving would change anything. Amounts only count while the teammate can pay: turned
 * off, what was typed into them is dropped.
 */
export function budgetFormChanged(start: BudgetForm, form: BudgetForm): boolean {
  const fields = changedBudgetFields(start, form);
  return fields.includes("enabled") || (form.enabled && fields.length > 0);
}

/** A fresher budget (changed on the web, say): what you haven't touched follows it. */
export function rebaseBudgetForm(
  draft: { start: BudgetForm; form: BudgetForm },
  fresh: BudgetForm,
): { start: BudgetForm; form: BudgetForm } {
  if (changedBudgetFields(draft.start, fresh).length === 0) return draft;
  const form = { ...fresh };
  for (const field of changedBudgetFields(draft.start, draft.form))
    (form as Record<BudgetField, unknown>)[field] = draft.form[field];
  return { start: fresh, form };
}

/** Why the budget can't be saved, in the worker's words, or null when it can. */
export function budgetProblem(form: BudgetForm): string | null {
  if (!form.enabled) return null;
  const budget = Number(form.budget);
  if (!form.budget.trim() || !Number.isFinite(budget) || budget <= 0)
    return "Give the budget in dollars, like 100.";
  const autoApprove = Number(form.autoApprove || 0);
  if (!Number.isFinite(autoApprove) || autoApprove < 0)
    return "Give the amount in dollars, like 20.";
  if (Math.round(autoApprove * 100) > Math.round(budget * 100))
    return "The amount to approve on its own can't be more than the budget.";
  return null;
}

/** What `teammates.setBudget` takes from the form, in dollars. */
export function budgetInput(form: BudgetForm): { budget: number | null; autoApprove: number } {
  return form.enabled
    ? { budget: Number(form.budget), autoApprove: Number(form.autoApprove || 0) }
    : { budget: null, autoApprove: 0 };
}

/** How much of the budget is spent, from 0 to 1, and the color that says how close it is. */
export function budgetUse(saved: { budgetCents: number | null; spentCents: number }): {
  share: number;
  tone: "done" | "attention" | "destructive";
} {
  const share = saved.budgetCents ? Math.min(1, saved.spentCents / saved.budgetCents) : 0;
  return { share, tone: share >= 0.9 ? "destructive" : share >= 0.7 ? "attention" : "done" };
}

/** "November", the month spending counts from (in UTC, like `monthStart`). */
export const spendingMonth = (now = new Date()) =>
  now.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

/** "$12 of $50 spent in November", or that the teammate can't pay for things. */
export function budgetSummary(
  saved: { budgetCents: number | null; spentCents: number },
  now = new Date(),
): string {
  if (saved.budgetCents === null) return "No budget, so they can't pay for things";
  return `${formatMoney(saved.spentCents)} of ${formatMoney(saved.budgetCents)} spent in ${spendingMonth(now)}`;
}

/** What each purchase's state is called, and its status color. */
export const PURCHASE_STATUS: Record<
  PurchaseStatus,
  { label: string; tone: "attention" | "done" | "muted" }
> = {
  pending: { label: "Needs your approval", tone: "attention" },
  approved: { label: "Approved", tone: "done" },
  paid: { label: "Paid", tone: "done" },
  denied: { label: "Denied", tone: "muted" },
  not_paid: { label: "Didn't go through", tone: "muted" },
};

/** Whether a purchase no longer counts: it's shown struck through. */
export const purchaseCalledOff = (status: PurchaseStatus) =>
  status === "denied" || status === "not_paid";

/** The budget's switch and its line, with the teammate's name. */
export const budgetCopy = (name: string) => ({
  canPay: `${name} can pay for things`,
  canPayHint: "With a card from the vault, up to a monthly budget.",
  monthly: "Monthly budget",
  autoApprove: "Approve on its own up to",
  autoApproveHint: "Larger purchases ask you first. Leave empty to approve each one.",
  noCard: `No card ${name} may use yet.`,
  saved: "Budget saved",
  off: `${name} can't pay for things now`,
  purchases: `What ${name} paid for, or asked to.`,
  noPurchases: `Nothing yet. When ${name} buys something, it shows here.`,
});
