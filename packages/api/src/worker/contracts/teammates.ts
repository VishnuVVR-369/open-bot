import { base, computer, id, ok } from "../base";
import {
  botProfileChangesSchema,
  botProfileSchema as teammateProfileSchema,
  createBotSchema,
  createdTeammateSchema,
  type TeammateBundle,
  teammateBundleSchema,
  updatedTeammateSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { budgetInputSchema } from "../../teammates";

export const teammatesContract = {
  /** The same service that creates a teammate when another teammate asks to. */
  create: base
    .route({ method: "POST", path: "/internal/bots" })
    .input(createBotSchema)
    .output(createdTeammateSchema),
  /** Refused with 409 when `expected_revision` is not the teammate's revision now. */
  update: base
    .route({ method: "POST", path: "/internal/bots/{teammateId}" })
    .input(
      z.object({
        teammateId: id,
        changes: botProfileChangesSchema,
        expected_revision: z.string().min(1).max(128),
      }),
    )
    .output(updatedTeammateSchema),
  /** The teammate as a file (`teammateBundleSchema`), and its slug for the file name. */
  export: base
    .route({ method: "GET", path: "/internal/teammates/{teammateId}/export" })
    .input(z.object({ teammateId: id }))
    // Everything the teammate has, as it is: a file can hold more than one may import.
    .output(
      z.object({
        slug: z.string(),
        bundle: z.custom<TeammateBundle>((value) => typeof value === "object" && value !== null),
      }),
    ),
  /**
   * A new teammate set up like another; its routines, watches and reminders start paused.
   * Memory and lessons come along with `copyMemory`.
   */
  duplicate: base
    .route({ method: "POST", path: "/internal/teammates/{teammateId}/duplicate" })
    .input(
      z.object({
        teammateId: id,
        name: teammateProfileSchema.shape.name,
        copyMemory: z.boolean(),
      }),
    )
    .output(z.object({ teammateId: z.string(), chatId: z.string(), memoryCopied: z.boolean() })),
  /** A new teammate from an exported file; its routines and page watches start paused. */
  import: base
    .route({ method: "POST", path: "/internal/teammates/import" })
    .input(z.object({ bundle: teammateBundleSchema }))
    .output(
      z.object({
        teammateId: z.string(),
        chatId: z.string(),
        name: z.string(),
        paused: z.number().int().nonnegative(),
      }),
    ),
  /** Make this teammate the lead. */
  setLead: base
    .route({ method: "POST", path: "/internal/teammates/{teammateId}/lead" })
    .input(z.object({ teammateId: id }))
    .output(ok),
  /**
   * Archive a teammate and stop its work. Never wakes the computer to answer; its screen is
   * forgotten on the way, waking the computer for that only.
   */
  archive: base
    .route({ method: "POST", path: "/internal/teammates/{teammateId}/archive" })
    .input(z.object({ teammateId: id }))
    .output(ok),
  setBudget: base
    .route({ method: "POST", path: "/internal/teammates/{teammateId}/budget" })
    .input(budgetInputSchema)
    .output(ok),
  /** Write the teammate's workspace (AGENTS.md, skills) on the computer now. */
  sync: computer
    .route({ method: "POST", path: "/internal/bots/{teammateId}/sync" })
    .input(z.object({ teammateId: id }))
    .output(ok),
};

export const proposalsContract = {
  /** Take suggested instructions; the same decision again succeeds, the other is a 409. */
  accept: base
    .route({ method: "POST", path: "/internal/proposals/{proposalId}/accept" })
    .input(z.object({ proposalId: id }))
    .output(ok),
  dismiss: base
    .route({ method: "POST", path: "/internal/proposals/{proposalId}/dismiss" })
    .input(z.object({ proposalId: id }))
    .output(ok),
};
