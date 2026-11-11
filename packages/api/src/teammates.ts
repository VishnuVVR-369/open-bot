import { z } from "zod";
import { id } from "./base";

/** What a teammate learned, suggested and spent, as its page shows it. */

const isoDate = z.string();

/** Something a teammate learned from your feedback. */
export const lessonViewSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: isoDate,
  /** The reply it was about, to jump back to it. */
  runId: z.string().nullable(),
  chatId: z.string().nullable(),
});
export type LessonView = z.infer<typeof lessonViewSchema>;

/** A teammate's suggested rewrite of its instructions. */
export const proposalViewSchema = z.object({
  id: z.string(),
  current: z.string(),
  proposed: z.string(),
  reason: z.string(),
  createdAt: isoDate,
});
export type ProposalView = z.infer<typeof proposalViewSchema>;

export const purchaseViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  /** The card's name and hint, while the card is still in the vault. */
  card: z.string().nullable(),
  amountCents: z.number(),
  merchant: z.string(),
  description: z.string(),
  status: z.enum(["pending", "approved", "denied", "paid", "not_paid"]),
  note: z.string().nullable(),
  chatId: z.string().nullable(),
  runId: z.string().nullable(),
  createdAt: isoDate,
});
export type PurchaseView = z.infer<typeof purchaseViewSchema>;

/** A teammate's monthly budget and what it spent of it. */
export const spendingViewSchema = z.object({
  budgetCents: z.number().nullable(),
  autoApproveCents: z.number(),
  spentCents: z.number(),
  purchases: z.array(purchaseViewSchema),
});
export type SpendingView = z.infer<typeof spendingViewSchema>;

/** The most a teammate's monthly budget can be, in dollars. */
export const MAX_BUDGET_DOLLARS = 100_000;

/** A teammate's monthly budget, in dollars, or null so it can't pay at all. */
export const budgetInputSchema = z.object({
  teammateId: id,
  budget: z
    .number({ error: "Give the budget in dollars, like 100." })
    .positive("Give the budget in dollars, like 100.")
    .max(MAX_BUDGET_DOLLARS, "Keep the budget under $100,000.")
    .nullable(),
  /** Purchases up to this go ahead on their own; 0 asks you about each one. */
  autoApprove: z
    .number({ error: "Give the amount in dollars, like 20." })
    .min(0, "Give the amount in dollars, like 20.")
    .max(MAX_BUDGET_DOLLARS, "Keep the amount under $100,000."),
});
