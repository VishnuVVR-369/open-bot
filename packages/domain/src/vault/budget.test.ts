import { describe, expect, it } from "vitest";
import {
  budgetForm,
  budgetFormChanged,
  budgetInput,
  budgetProblem,
  budgetSummary,
  budgetUse,
  dollarsText,
  moneyInput,
  rebaseBudgetForm,
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

  it("follows a budget changed elsewhere for what you haven't touched", () => {
    const start = budgetForm({ budgetCents: 5000, autoApproveCents: 0 });
    const draft = { start, form: { ...start, autoApprove: "5" } };
    const fresh = budgetForm({ budgetCents: 9000, autoApproveCents: 1000 });
    expect(rebaseBudgetForm(draft, fresh)).toEqual({
      start: fresh,
      form: { enabled: true, budget: "90", autoApprove: "5" },
    });
    expect(rebaseBudgetForm(draft, start)).toBe(draft);
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
