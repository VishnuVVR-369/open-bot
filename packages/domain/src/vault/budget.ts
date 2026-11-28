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

export type BudgetField = keyof BudgetForm;

/** Whether two forms say something different for a field: "50" and "50.00" are the same. */
function differs(a: BudgetForm, b: BudgetForm, field: BudgetField): boolean {
  return field === "enabled"
    ? a.enabled !== b.enabled
    : Number(a[field] || 0) !== Number(b[field] || 0);
}

const BUDGET_FIELDS: readonly BudgetField[] = ["enabled", "budget", "autoApprove"];

function changedBudgetFields(start: BudgetForm, form: BudgetForm): BudgetField[] {
  return BUDGET_FIELDS.filter((field) => differs(start, form, field));
}

/**
 * Whether saving would change anything. Amounts only count while the teammate can pay: turned
 * off, what was typed into them is dropped.
 */
export function budgetFormChanged(start: BudgetForm, form: BudgetForm): boolean {
  const fields = changedBudgetFields(start, form);
  return fields.includes("enabled") || (form.enabled && fields.length > 0);
}

/** The budget a form saves, in cents, as the worker stores it. */
export function savedBudget(form: BudgetForm): SavedBudget {
  const { budget, autoApprove } = budgetInput(form);
  return {
    budgetCents: budget === null ? null : Math.round(budget * 100),
    autoApproveCents: Math.round(autoApprove * 100),
  };
}

/**
 * An edit of a teammate's budget, as the web's Spending tab and the phone's budget screen keep it.
 * A save names `base` as the budget it expects (`teammates.setBudget`'s `expected`), so a budget
 * saved elsewhere since is refused rather than overwritten.
 */
export interface BudgetDraft {
  /** The saved budget your changes are based on. */
  base: SavedBudget;
  form: BudgetForm;
  /** The fields you changed. The others follow the saved budget as it changes elsewhere. */
  touched: readonly BudgetField[];
  /**
   * A budget saved elsewhere since that changed a field you changed too, to something else. It's
   * shown, and saving waits until you take it or keep yours (`settleBudgetConflict`).
   */
  theirs: SavedBudget | null;
}

export function budgetDraft(saved: SavedBudget): BudgetDraft {
  return { base: saved, form: budgetForm(saved), touched: [], theirs: null };
}

/** You changed the form. */
export function editBudget(draft: BudgetDraft, patch: Partial<BudgetForm>): BudgetDraft {
  const touched = new Set(draft.touched);
  for (const field of Object.keys(patch) as BudgetField[]) touched.add(field);
  return { ...draft, form: { ...draft.form, ...patch }, touched: [...touched] };
}

/** The fields you changed that still say something other than the base. */
function yourFields(draft: BudgetDraft): BudgetField[] {
  const base = budgetForm(draft.base);
  return draft.touched.filter((field) => differs(base, draft.form, field));
}

/** The fields where a fresher budget and your changes disagree. */
function conflicting(draft: BudgetDraft, fresh: SavedBudget): BudgetField[] {
  const base = budgetForm(draft.base);
  const theirs = budgetForm(fresh);
  return yourFields(draft).filter(
    (field) => differs(base, theirs, field) && differs(draft.form, theirs, field),
  );
}

/**
 * The saved budget as it is now (changed here, on the web, or read again after a refused save).
 * What you haven't changed follows it. When it changed a field you changed too, to something else,
 * your value stays and the new budget waits in `theirs`; saving is off until you pick. A purchase
 * meanwhile changes only what's spent, so it never reaches here.
 */
export function followBudget(draft: BudgetDraft, fresh: SavedBudget): BudgetDraft {
  const mine = yourFields(draft);
  const form = { ...budgetForm(fresh) };
  for (const field of mine) (form as Record<BudgetField, unknown>)[field] = draft.form[field];
  const clash = conflicting(draft, fresh).length > 0;
  const next: BudgetDraft = {
    base: clash ? draft.base : fresh,
    form,
    touched: mine,
    theirs: clash ? fresh : null,
  };
  return sameDraft(draft, next) ? draft : next;
}

/** Take the budget saved elsewhere for the fields you both changed, or keep yours over it. */
export function settleBudgetConflict(draft: BudgetDraft, keep: "theirs" | "mine"): BudgetDraft {
  const theirs = draft.theirs;
  if (!theirs) return draft;
  if (keep === "mine") return { ...draft, base: theirs, theirs: null };
  const taken = conflicting(draft, theirs);
  const fresh = budgetForm(theirs);
  const form = { ...draft.form };
  for (const field of taken) (form as Record<BudgetField, unknown>)[field] = fresh[field];
  return {
    base: theirs,
    form,
    touched: draft.touched.filter((field) => !taken.includes(field)),
    theirs: null,
  };
}

/** The form was saved: it's the budget now, and the base the next save names. */
export function budgetSaved(draft: BudgetDraft): BudgetDraft {
  return { base: savedBudget(draft.form), form: draft.form, touched: [], theirs: null };
}

/** Whether saving would change the budget it names. */
export const budgetDraftChanged = (draft: BudgetDraft) =>
  budgetFormChanged(budgetForm(draft.base), draft.form);

/** What the budget was changed to elsewhere, for a conflict. */
export function budgetConflictText(theirs: SavedBudget, name: string): string {
  if (theirs.budgetCents === null) return `Changed elsewhere: ${name} can't pay for things now.`;
  const each =
    theirs.autoApproveCents > 0
      ? `approving up to ${formatMoney(theirs.autoApproveCents)} on its own`
      : "asking you about each purchase";
  return `Changed elsewhere to ${formatMoney(theirs.budgetCents)} a month, ${each}.`;
}

const sameSaved = (a: SavedBudget | null, b: SavedBudget | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.budgetCents === b.budgetCents &&
    a.autoApproveCents === b.autoApproveCents);

function sameDraft(a: BudgetDraft, b: BudgetDraft): boolean {
  return (
    sameSaved(a.base, b.base) &&
    sameSaved(a.theirs, b.theirs) &&
    a.form.enabled === b.form.enabled &&
    a.form.budget === b.form.budget &&
    a.form.autoApprove === b.form.autoApprove &&
    a.touched.length === b.touched.length &&
    a.touched.every((field) => b.touched.includes(field))
  );
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
