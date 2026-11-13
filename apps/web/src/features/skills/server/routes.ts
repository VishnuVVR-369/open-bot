import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";
import { listSkills } from "./queries";

/** Skills, as the browser and the phone ask (`contract.skills`). The worker owns the writes. */
export function skillRoutes() {
  return {
    list: os.skills.list.handler(() => listSkills()),
    save: os.skills.save.handler(({ input }) => worker.skills.save(input)),
    remove: os.skills.remove.handler(({ input }) => worker.skills.remove(input)),
  };
}
