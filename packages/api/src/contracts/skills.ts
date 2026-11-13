import { skillInputSchema } from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import { skillViewSchema } from "../skills";

export const skillsContract = {
  list: base.output(z.array(skillViewSchema)),
  /** Create a skill, or with `id`, change one. */
  save: base
    .input(skillInputSchema.extend({ id: id.nullable().optional() }))
    .output(z.object({ id: z.string() })),
  remove: base.input(z.object({ skillId: id })).output(ok),
};
