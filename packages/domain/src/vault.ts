/**
 * The vault: logins and payment cards that teammates fill in on the computer without ever reading
 * them, and the monthly budget each teammate spends cards from.
 */

export type VaultKind = "login" | "card";

export interface LoginSecret {
  username: string;
  password: string;
}

export interface CardSecret {
  number: string;
  /** MM/YY. */
  expiry: string;
  cvc: string;
  name: string;
  zip: string;
}

export type VaultSecret = LoginSecret | CardSecret;

/** What a teammate can fill from each kind of item, in the order a form usually asks. */
export const VAULT_FIELDS = {
  login: ["username", "password"],
  card: ["number", "expiry", "cvc", "name", "zip"],
} as const satisfies Record<VaultKind, readonly string[]>;

export type VaultField = (typeof VAULT_FIELDS)[VaultKind][number];

export const FIELD_LABEL: Record<VaultField, string> = {
  username: "username",
  password: "password",
  number: "card number",
  expiry: "expiry date",
  cvc: "security code",
  name: "name on the card",
  zip: "billing ZIP code",
};

/** How long an approved purchase lets a teammate fill its card. */
export const PURCHASE_WINDOW_MS = 30 * 60_000;

/** "github.com" from "https://www.github.com/login", "GitHub.com" or "github.com/". */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host !== "localhost") return null;
  return host;
}

/** Whether a page's host belongs to a login's site: the site itself or one of its subdomains. */
export function domainMatches(host: string, domain: string): boolean {
  const page = normalizeDomain(host);
  const site = normalizeDomain(domain);
  if (!page || !site) return false;
  return page === site || page.endsWith(`.${site}`);
}

export function cardDigits(number: string): string {
  return number.replace(/[\s-]/g, "");
}

/** The Luhn checksum every card number carries. */
export function luhnValid(number: string): boolean {
  const digits = cardDigits(number);
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function cardBrand(number: string): string {
  const digits = cardDigits(number);
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
  return "Card";
}

/** "Visa •••• 4242": enough to tell cards apart, never enough to use one. */
export function cardHint(number: string): string {
  return `${cardBrand(number)} •••• ${cardDigits(number).slice(-4)}`;
}

/** "08/29" from "8/29", "08/2029" or "0829", or null when it isn't a date. */
export function normalizeExpiry(input: string): string | null {
  const match = /^\s*(\d{1,2})\s*\/?\s*(\d{2}|\d{4})\s*$/.exec(input);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  const year = match[2]!.slice(-2);
  return `${String(month).padStart(2, "0")}/${year}`;
}

/** Why a card can't be saved, or null when it can. */
export function invalidCard(card: CardSecret): string | null {
  if (!luhnValid(card.number)) return "That card number isn't valid.";
  if (!normalizeExpiry(card.expiry)) return "Give the expiry date as MM/YY.";
  if (!/^\d{3,4}$/.test(card.cvc.trim())) return "The security code is 3 or 4 digits.";
  if (!card.name.trim()) return "Add the name on the card.";
  return null;
}

/** "$42.50" from 4250 cents. */
export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** Cents from an amount in dollars, like 42.5 or "42.50", or null when it isn't one. */
export function toCents(amount: number | string): number | null {
  const value = typeof amount === "number" ? amount : Number(amount.trim().replace(/^\$/, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export type BudgetDecision =
  { ok: false; reason: string } | { ok: true; needsApproval: boolean; leftCents: number };

/**
 * Whether a teammate may spend an amount this month. Without a budget it can't pay at all; within
 * it, purchases up to the auto-approve amount go ahead and larger ones ask you.
 */
export function budgetDecision(input: {
  budgetCents: number | null;
  autoApproveCents: number;
  spentCents: number;
  amountCents: number;
}): BudgetDecision {
  const { budgetCents, autoApproveCents, spentCents, amountCents } = input;
  if (budgetCents === null || budgetCents <= 0)
    return {
      ok: false,
      reason:
        "You don't have a spending budget, so you can't pay for things. Tell the user what you'd buy and ask them to set you a budget on your page.",
    };
  const left = Math.max(0, budgetCents - spentCents);
  if (amountCents > left)
    return {
      ok: false,
      reason: `That's over your budget: ${formatMoney(left)} of ${formatMoney(budgetCents)} is left this month. Tell the user, and don't buy it.`,
    };
  return { ok: true, needsApproval: amountCents > autoApproveCents, leftCents: left - amountCents };
}

/** The first day of this month in UTC, where a teammate's monthly spending starts. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
