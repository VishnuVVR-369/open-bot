import { purchaseStatusSchema } from "@open-bot/domain";
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

/** The suggestion waiting for you from one teammate, with the instructions as they are now. */
export const pendingProposalViewSchema = proposalViewSchema.extend({
  teammateId: z.string(),
  /** What accepting it replaces: the teammate's instructions now, perhaps changed since. */
  instructionsNow: z.string(),
});
export type PendingProposalView = z.infer<typeof pendingProposalViewSchema>;

/** The longest instructions a teammate can have, and so the longest you can have reviewed. */
const instructions = z.string().max(20_000);

/**
 * Taking a suggestion as you reviewed it. `expectedInstructions` is the teammate's instructions the
 * change was shown against (`instructionsNow`): if they changed since, or the teammate was
 * archived, it's refused with `STATE_CONFLICT` instead of overwriting what's there now. The app's
 * API requires it; the worker's keeps it optional for web apps deployed before it.
 */
export const proposalAcceptSchema = z.object({
  proposalId: id,
  expectedInstructions: instructions,
});
export const workerProposalAcceptSchema = proposalAcceptSchema.partial({
  expectedInstructions: true,
});

export const purchaseViewSchema = z.object({
  id: z.string(),
  teammateId: z.string(),
  /** The card's name and hint, while the card is still in the vault. */
  card: z.string().nullable(),
  amountCents: z.number(),
  merchant: z.string(),
  description: z.string(),
  status: purchaseStatusSchema,
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
  /**
   * The budget as you saw it, in cents. When given, a budget changed since (on the web, say) is
   * refused with `STATE_CONFLICT` instead of being overwritten.
   */
  expected: z
    .object({
      budgetCents: z.number().int().nonnegative().nullable(),
      autoApproveCents: z.number().int().nonnegative(),
    })
    .optional(),
});
