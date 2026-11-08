import { z } from "zod";

/** A saved skill: reusable instructions you run with `/name`. */
export const skillViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  /** The teammate who can use it, or null for every teammate. */
  botId: z.string().nullable(),
  createdBy: z.enum(["user", "bot"]),
  createdByBotId: z.string().nullable(),
  updatedAt: z.string(),
});
export type SkillView = z.infer<typeof skillViewSchema>;

/** A skill without its instructions, for menus and lists. */
export const skillSummarySchema = skillViewSchema.omit({ instructions: true });
export type SkillSummary = z.infer<typeof skillSummarySchema>;
