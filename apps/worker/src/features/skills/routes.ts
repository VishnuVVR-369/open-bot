import { os } from "../../core/rpc";
import type { SkillService } from "./service";

const ok = { ok: true } as const;

/** Skills as the web app saves and removes them (`workerContract.skills`). */
export function skillRoutes(skills: SkillService) {
  return {
    save: os.skills.save.handler(async ({ input: { id, ...skill } }) => ({
      id: (await skills.save(skill, { kind: "user" }, id ?? undefined)).id,
    })),
    remove: os.skills.remove.handler(async ({ input }) => {
      await skills.remove(input.skillId);
      return ok;
    }),
  };
}
