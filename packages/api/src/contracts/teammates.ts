import {
  botProfileSchema as profileSchema,
  createdTeammateSchema,
  updatedTeammateSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import { budgetInputSchema, lessonViewSchema, spendingViewSchema } from "../teammates";
import { botSummarySchema } from "../views";

/** The biggest teammate file that can be imported, in characters. */
export const MAX_TEAMMATE_FILE = 2_000_000;

export const teammatesContract = {
  /** Your teammates (not archived), oldest first, with what each is doing now. */
  list: base.output(z.array(botSummarySchema)),
  /** What a teammate learned from your feedback, newest first. */
  lessons: base.input(z.object({ botId: id })).output(z.array(lessonViewSchema)),
  /** A teammate's monthly budget, what it spent, and its latest purchases. */
  spending: base.input(z.object({ botId: id })).output(spendingViewSchema),
  /**
   * A new teammate, with its template's skills and the starter automations you kept, made by the
   * same service as when a teammate creates one.
   */
  create: base
    .input(
      z.object({
        profile: profileSchema,
        templateId: z.string().min(1).nullable(),
        starterIds: z.array(z.string().max(80)).max(20),
      }),
    )
    .output(createdTeammateSchema),
  /**
   * Save the profile. `revision` is the teammate as you loaded it: a change made since, by you
   * elsewhere or by a teammate, fails with `STATE_CONFLICT` instead of being overwritten.
   */
  update: base
    .input(
      z.object({ teammateId: id, profile: profileSchema, revision: z.string().min(1).max(128) }),
    )
    .output(updatedTeammateSchema),
  /**
   * A new teammate set up like another: the same job, instructions and carefulness, their own
   * skills and approval rules, and their routines and page watches, paused. Webhooks and chats
   * stay with the original. Memory and lessons come along with `copyMemory`.
   */
  duplicate: base
    .input(z.object({ teammateId: id, name: profileSchema.shape.name, copyMemory: z.boolean() }))
    .output(z.object({ teammateId: z.string(), chatId: z.string(), memoryCopied: z.boolean() })),
  /** A new teammate from an exported file; its routines and page watches start paused. */
  import: base
    .input(
      z.object({
        file: z.string().max(MAX_TEAMMATE_FILE, "Teammate files are smaller than that."),
      }),
    )
    .output(
      z.object({
        teammateId: z.string(),
        chatId: z.string(),
        name: z.string(),
        /** How many routines and watches came in paused. */
        paused: z.number().int().nonnegative(),
      }),
    ),
  /** Make this teammate the lead, who answers group chats when nobody is mentioned. */
  setLead: base.input(z.object({ teammateId: id })).output(ok),
  /** Archive a teammate: its chats are archived, its automations paused, its work stopped. */
  archive: base.input(z.object({ teammateId: id })).output(ok),
  /** What a teammate may spend from the vault's cards each month; see `budgetInputSchema`. */
  setBudget: base.input(budgetInputSchema).output(ok),
};

export const proposalsContract = {
  /**
   * Take the instructions a teammate suggested for itself; they apply from its next message.
   * Deciding again the same way succeeds; one decided the other way fails with
   * `STATE_CONFLICT`.
   */
  accept: base.input(z.object({ proposalId: id })).output(ok),
  dismiss: base.input(z.object({ proposalId: id })).output(ok),
};
