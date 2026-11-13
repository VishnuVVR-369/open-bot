import "server-only";
import { ApiError } from "@/lib/server/api/errors";
import { os } from "@/lib/server/api/rpc";
import { listBots } from "@/lib/server/queries";
import {
  acceptProposal,
  archiveTeammate,
  createTeammate,
  dismissProposal,
  duplicateTeammate,
  getSpending,
  importTeammate,
  listLessons,
  setBudget,
  setLead,
  updateTeammate,
} from "./service";

/**
 * Teammates and the instructions they suggest for themselves, as the browser and the phone ask
 * (`contract.teammates` and `contract.proposals`).
 */
export function teammateRoutes() {
  return {
    teammates: {
      list: os.teammates.list.handler(() => listBots()),
      lessons: os.teammates.lessons.handler(({ input }) => listLessons(input.botId)),
      spending: os.teammates.spending.handler(async ({ input }) => {
        const spending = await getSpending(input.botId);
        if (!spending) throw new ApiError("NOT_FOUND", "No such teammate.");
        return spending;
      }),
      create: os.teammates.create.handler(({ input }) => createTeammate(input)),
      update: os.teammates.update.handler(({ input }) => updateTeammate(input)),
      duplicate: os.teammates.duplicate.handler(({ input }) => duplicateTeammate(input)),
      import: os.teammates.import.handler(({ input }) => importTeammate(input)),
      setLead: os.teammates.setLead.handler(({ input }) => setLead(input)),
      archive: os.teammates.archive.handler(({ input }) => archiveTeammate(input)),
      setBudget: os.teammates.setBudget.handler(({ input }) => setBudget(input)),
    },
    proposals: {
      accept: os.proposals.accept.handler(({ input }) => acceptProposal(input)),
      dismiss: os.proposals.dismiss.handler(({ input }) => dismissProposal(input)),
    },
  };
}
