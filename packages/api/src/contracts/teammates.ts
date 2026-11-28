import {
  teammateProfileSchema as profileSchema,
  teammateProfileChangesSchema,
  createdTeammateSchema,
  updatedTeammateSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import {
  budgetInputSchema,
  lessonViewSchema,
  pendingProposalViewSchema,
  proposalAcceptSchema,
  spendingViewSchema,
  teammateProfileViewSchema,
} from "../teammates";
import { teammateSummarySchema } from "../views";

/** The biggest teammate file that can be imported, in characters. */
export const MAX_TEAMMATE_FILE = 2_000_000;

export const teammatesContract = {
  /** Your teammates (not archived), oldest first, with what each is doing now. */
  list: base.output(z.array(teammateSummarySchema)),
  /** A teammate's profile to edit, with the revision `update` takes. Not found once archived. */
  profile: base.input(z.object({ teammateId: id })).output(teammateProfileViewSchema),
  /** What a teammate learned from your feedback, newest first. */
  lessons: base.input(z.object({ teammateId: id })).output(z.array(lessonViewSchema)),
  /** A teammate's monthly budget, what it spent, and its latest purchases. */
  spending: base.input(z.object({ teammateId: id })).output(spendingViewSchema),
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
   * Save the profile: the fields you changed, or all of them (as clients from before sent it).
   * Only what's sent is checked, so a field saved before today's rules (an older color) doesn't
   * stop a save that leaves it as it is. `revision` is the profile as you loaded it (`profile`):
   * a change to it made since, by you elsewhere or by a teammate, fails with `STATE_CONFLICT`
   * instead of being overwritten. Changes to the rest of the teammate (its budget, the lead) don't.
   */
  update: base
    .input(
      z.object({
        teammateId: id,
        profile: teammateProfileChangesSchema,
        revision: z.string().min(1).max(128),
      }),
    )
    .output(updatedTeammateSchema),
  /**
   * A new teammate set up like another: the same job, instructions and carefulness, their own
   * skills and approval rules, and their routines and page watches, paused. Webhooks and chats
   * stay with the original. Memory and lessons come along with `copyMemory`.
   *
   * `copyId` is a fresh id for the copy, kept for retries: the copy is made under it, so sending
   * the same ask again after an answer that never came answers with the copy the first ask made
   * (named and with memory as that ask chose) instead of making another. `memoryCopied` then says
   * whether its memory really came along. An id another teammate already has, or a copy of a
   * different teammate, fails with `CONFLICT`. It's optional for clients from before it.
   */
  duplicate: base
    .input(
      z.object({
        teammateId: id,
        name: profileSchema.shape.name,
        copyMemory: z.boolean(),
        copyId: id.optional(),
      }),
    )
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
  /**
   * Archive a teammate: its chats are archived, its automations paused, its work stopped. An
   * archived lead stops leading, and nobody is made lead in its place: a group message that
   * mentions nobody goes to the chat's first member until you choose a lead.
   */
  archive: base.input(z.object({ teammateId: id })).output(ok),
  /** What a teammate may spend from the vault's cards each month; see `budgetInputSchema`. */
  setBudget: base.input(budgetInputSchema).output(ok),
};

export const proposalsContract = {
  /**
   * The instructions a teammate suggests for itself and you haven't decided yet, or null. A
   * newer suggestion replaces the one waiting, so there's at most one per teammate.
   */
  pending: base.input(z.object({ teammateId: id })).output(pendingProposalViewSchema.nullable()),
  /**
   * Take the instructions a teammate suggested for itself; they apply from its next message.
   * Deciding again the same way succeeds; one decided the other way fails with
   * `STATE_CONFLICT`, as does one whose instructions changed since you reviewed it
   * (`expectedInstructions`) or whose teammate was archived.
   */
  accept: base.input(proposalAcceptSchema).output(ok),
  dismiss: base.input(z.object({ proposalId: id })).output(ok),
};
