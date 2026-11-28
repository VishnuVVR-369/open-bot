import { describe, expect, it } from "vitest";
import {
  budgetConflictText,
  budgetDraft,
  budgetDraftChanged,
  budgetForm,
  budgetFormChanged,
  budgetInput,
  budgetProblem,
  budgetSummary,
  budgetUse,
  dollarsText,
  budgetSaved,
  editBudget,
  followBudget,
  moneyInput,
  savedBudget,
  settleBudgetConflict,
} from "./budget";

describe("the budget form", () => {
  it("starts from the saved budget, in dollars", () => {
    expect(budgetForm({ budgetCents: 5050, autoApproveCents: 1000 })).toEqual({
      enabled: true,
      budget: "50.5",
      autoApprove: "10",
    });
    expect(budgetForm({ budgetCents: null, autoApproveCents: 0 })).toEqual({
      enabled: false,
      budget: "",
      autoApprove: "",
    });
    expect(dollarsText(0)).toBe("");
  });

  it("keeps an amount to digits and one point", () => {
    expect(moneyInput("$1,250.5.0")).toBe("1250.50");
    expect(moneyInput("abc")).toBe("");
  });

  it("counts only changes that would be saved", () => {
    const start = budgetForm({ budgetCents: 5000, autoApproveCents: 0 });
    expect(budgetFormChanged(start, { ...start, budget: "50.00" })).toBe(false);
    expect(budgetFormChanged(start, { ...start, budget: "60" })).toBe(true);
    const off = budgetForm({ budgetCents: null, autoApproveCents: 0 });
    expect(budgetFormChanged(off, { ...off, budget: "60" })).toBe(false);
    expect(budgetFormChanged(off, { ...off, enabled: true })).toBe(true);
  });

  it("refuses what the worker would, in its words", () => {
    const on = { enabled: true, budget: "50", autoApprove: "80" };
    expect(budgetProblem(on)).toBe(
      "The amount to approve on its own can't be more than the budget.",
    );
    expect(budgetProblem({ ...on, budget: "" })).toBe("Give the budget in dollars, like 100.");
    expect(budgetProblem({ ...on, autoApprove: "" })).toBeNull();
    expect(budgetProblem({ enabled: false, budget: "", autoApprove: "" })).toBeNull();
  });

  it("sends dollars, or no budget at all when it's off", () => {
    expect(budgetInput({ enabled: true, budget: "50", autoApprove: "" })).toEqual({
      budget: 50,
      autoApprove: 0,
    });
    expect(budgetInput({ enabled: false, budget: "50", autoApprove: "10" })).toEqual({
      budget: null,
      autoApprove: 0,
    });
  });
});

describe("editing a budget while it changes elsewhere", () => {
  const fifty = { budgetCents: 5000, autoApproveCents: 0 };

  it("follows a budget changed elsewhere for what you haven't touched", () => {
    const draft = editBudget(budgetDraft(fifty), { autoApprove: "5" });
    const fresh = { budgetCents: 9000, autoApproveCents: 0 };
    const next = followBudget(draft, fresh);
    expect(next).toEqual({
      base: fresh,
      form: { enabled: true, budget: "90", autoApprove: "5" },
      touched: ["autoApprove"],
      theirs: null,
    });
    // The same budget again changes nothing, so a refresh doesn't redraw the form.
    expect(followBudget(next, fresh)).toBe(next);
  });

  it("names the budget the edit started from, not the latest one read", () => {
    // The phone shows $50 and you type $60; the web sets $80 and the phone reads it.
    const draft = followBudget(editBudget(budgetDraft(fifty), { budget: "60" }), {
      budgetCents: 8000,
      autoApproveCents: 0,
    });
    // Saving now would overwrite $80 with $60 unseen: it still names $50, so the worker refuses.
    expect(draft.base).toEqual(fifty);
    expect(draft.form.budget).toBe("60");
    expect(draft.theirs).toEqual({ budgetCents: 8000, autoApproveCents: 0 });
    expect(budgetConflictText(draft.theirs!, "Scout")).toBe(
      "Changed elsewhere to $80 a month, asking you about each purchase.",
    );
  });

  it("shows a fresh value on a touched field, and keeps following the others meanwhile", () => {
    const draft = followBudget(editBudget(budgetDraft(fifty), { budget: "60" }), {
      budgetCents: 8000,
      autoApproveCents: 1000,
    });
    expect(draft.form).toEqual({ enabled: true, budget: "60", autoApprove: "10" });
    expect(draft.theirs).toEqual({ budgetCents: 8000, autoApproveCents: 1000 });

    // Take theirs: the field you both changed is theirs, and the next save names their budget.
    const taken = settleBudgetConflict(draft, "theirs");
    expect(taken).toEqual({
      base: { budgetCents: 8000, autoApproveCents: 1000 },
      form: { enabled: true, budget: "80", autoApprove: "10" },
      touched: [],
      theirs: null,
    });
    expect(budgetDraftChanged(taken)).toBe(false);

    // Keep yours: your $60 stays, and the save names their budget, so it goes through.
    const kept = settleBudgetConflict(draft, "mine");
    expect(kept.base).toEqual({ budgetCents: 8000, autoApproveCents: 1000 });
    expect(kept.form.budget).toBe("60");
    expect(kept.theirs).toBeNull();
    expect(budgetDraftChanged(kept)).toBe(true);
  });

  it("isn't a conflict when the budget was set elsewhere to what you typed, or set back", () => {
    const draft = editBudget(budgetDraft(fifty), { budget: "60" });
    const same = followBudget(draft, { budgetCents: 6000, autoApproveCents: 0 });
    expect(same.theirs).toBeNull();
    expect(same.base).toEqual({ budgetCents: 6000, autoApproveCents: 0 });
    expect(budgetDraftChanged(same)).toBe(false);

    const clash = followBudget(draft, { budgetCents: 8000, autoApproveCents: 0 });
    expect(clash.theirs).not.toBeNull();
    // Set back to $50 elsewhere: nothing to choose between any more.
    const back = followBudget(clash, fifty);
    expect(back.theirs).toBeNull();
    expect(back.form.budget).toBe("60");
  });

  it("follows a field you typed back to what it was", () => {
    const draft = editBudget(editBudget(budgetDraft(fifty), { budget: "60" }), { budget: "50" });
    const next = followBudget(draft, { budgetCents: 8000, autoApproveCents: 0 });
    expect(next.theirs).toBeNull();
    expect(next.form.budget).toBe("80");
  });

  it("says when paying was turned off elsewhere", () => {
    const draft = followBudget(editBudget(budgetDraft(fifty), { budget: "60" }), {
      budgetCents: null,
      autoApproveCents: 0,
    });
    expect(draft.theirs).toEqual({ budgetCents: null, autoApproveCents: 0 });
    expect(budgetConflictText(draft.theirs!, "Scout")).toBe(
      "Changed elsewhere: Scout can't pay for things now.",
    );
    expect(budgetConflictText({ budgetCents: 8000, autoApproveCents: 1250 }, "Scout")).toBe(
      "Changed elsewhere to $80 a month, approving up to $12.50 on its own.",
    );
  });

  it("names what it saved once saved", () => {
    const saved = budgetSaved(editBudget(budgetDraft(fifty), { budget: "60.5", autoApprove: "5" }));
    expect(saved.base).toEqual({ budgetCents: 6050, autoApproveCents: 500 });
    expect(budgetDraftChanged(saved)).toBe(false);
    // The refresh that follows the save is the same budget.
    expect(followBudget(saved, saved.base)).toBe(saved);
    expect(savedBudget({ enabled: false, budget: "60", autoApprove: "5" })).toEqual({
      budgetCents: null,
      autoApproveCents: 0,
    });
  });
});

describe("spending", () => {
  it("colors the bar by how close it is to the budget", () => {
    expect(budgetUse({ budgetCents: 10000, spentCents: 5000 })).toEqual({
      share: 0.5,
      tone: "done",
    });
    expect(budgetUse({ budgetCents: 10000, spentCents: 7000 }).tone).toBe("attention");
    expect(budgetUse({ budgetCents: 10000, spentCents: 12000 })).toEqual({
      share: 1,
      tone: "destructive",
    });
    expect(budgetUse({ budgetCents: null, spentCents: 0 }).share).toBe(0);
  });

  it("says what was spent in the month spending counts from", () => {
    // Still October in UTC, though it's November east of it.
    const now = new Date("2026-10-31T23:30:00Z");
    expect(budgetSummary({ budgetCents: 5000, spentCents: 1250 }, now)).toBe(
      "$12.50 of $50 spent in October",
    );
    expect(budgetSummary({ budgetCents: null, spentCents: 0 }, now)).toBe(
      "No budget, so they can't pay for things",
    );
  });
});
