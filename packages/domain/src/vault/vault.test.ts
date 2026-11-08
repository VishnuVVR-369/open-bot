import { describe, expect, it } from "vitest";
import {
  budgetDecision,
  cardHint,
  domainMatches,
  formatMoney,
  invalidCard,
  luhnValid,
  normalizeDomain,
  normalizeExpiry,
  toCents,
} from "./vault";

describe("normalizeDomain", () => {
  it("keeps just the site", () => {
    expect(normalizeDomain("https://www.GitHub.com/login?next=/")).toBe("github.com");
    expect(normalizeDomain("github.com/")).toBe("github.com");
    expect(normalizeDomain("accounts.google.com")).toBe("accounts.google.com");
    expect(normalizeDomain("localhost")).toBe("localhost");
  });

  it("refuses what isn't a site", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("not a site")).toBeNull();
    expect(normalizeDomain("github")).toBeNull();
  });
});

describe("domainMatches", () => {
  it("matches the site and its subdomains", () => {
    expect(domainMatches("github.com", "github.com")).toBe(true);
    expect(domainMatches("www.github.com", "github.com")).toBe(true);
    expect(domainMatches("gist.github.com", "github.com")).toBe(true);
  });

  it("doesn't match look-alikes", () => {
    expect(domainMatches("github.com.evil.io", "github.com")).toBe(false);
    expect(domainMatches("evilgithub.com", "github.com")).toBe(false);
    expect(domainMatches("github.com", "gist.github.com")).toBe(false);
  });
});

describe("cards", () => {
  it("checks the number", () => {
    expect(luhnValid("4242 4242 4242 4242")).toBe(true);
    expect(luhnValid("4242-4242-4242-4241")).toBe(false);
    expect(luhnValid("1234")).toBe(false);
  });

  it("hints without revealing it", () => {
    expect(cardHint("4242424242424242")).toBe("Visa •••• 4242");
    expect(cardHint("5555 5555 5555 4444")).toBe("Mastercard •••• 4444");
    expect(cardHint("378282246310005")).toBe("Amex •••• 0005");
  });

  it("reads expiry dates", () => {
    expect(normalizeExpiry("8/29")).toBe("08/29");
    expect(normalizeExpiry("08/2029")).toBe("08/29");
    expect(normalizeExpiry("0829")).toBe("08/29");
    expect(normalizeExpiry("13/29")).toBeNull();
  });

  it("explains what's wrong", () => {
    const card = { number: "4242424242424242", expiry: "08/29", cvc: "123", name: "A", zip: "" };
    expect(invalidCard(card)).toBeNull();
    expect(invalidCard({ ...card, number: "4242" })).toMatch(/number/);
    expect(invalidCard({ ...card, cvc: "12" })).toMatch(/security code/);
  });
});

describe("money", () => {
  it("formats and parses dollars", () => {
    expect(formatMoney(4250)).toBe("$42.50");
    expect(formatMoney(10000)).toBe("$100");
    expect(toCents("42.5")).toBe(4250);
    expect(toCents("$19.99")).toBe(1999);
    expect(toCents(0)).toBeNull();
    expect(toCents("ten")).toBeNull();
  });
});

describe("budgetDecision", () => {
  const base = { budgetCents: 10000, autoApproveCents: 2000, spentCents: 0, amountCents: 1000 };

  it("can't pay without a budget", () => {
    expect(budgetDecision({ ...base, budgetCents: null }).ok).toBe(false);
  });

  it("goes ahead with small purchases and asks about larger ones", () => {
    expect(budgetDecision(base)).toEqual({ ok: true, needsApproval: false, leftCents: 9000 });
    expect(budgetDecision({ ...base, amountCents: 5000 })).toMatchObject({
      ok: true,
      needsApproval: true,
    });
  });

  it("stops at the budget", () => {
    const decision = budgetDecision({ ...base, spentCents: 9500, amountCents: 1000 });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toMatch(/\$5 of \$100 is left/);
  });
});
