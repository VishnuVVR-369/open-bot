import { base, id, ok } from "../base";
import { skillInputSchema } from "@open-bot/domain";
import { z } from "zod";

export const skillsContract = {
  /** Create a skill, or with `id`, change one. */
  save: base
    .route({ method: "POST", path: "/internal/skills" })
    .input(skillInputSchema.extend({ id: id.nullable().optional() }))
    .output(z.object({ id: z.string() })),
  remove: base
    .route({ method: "POST", path: "/internal/skills/{skillId}/delete" })
    .input(z.object({ skillId: id }))
    .output(ok),
};
