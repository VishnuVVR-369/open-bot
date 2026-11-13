import type { Bot } from "../../core/db-types";
import { os } from "../../core/rpc";
import type { BotService } from "./service";

/** Writes a teammate's workspace on the computer: the run executor, which uses teammates itself. */
interface WorkspaceSync {
  syncWorkspace(teammate: Bot): Promise<unknown>;
}

const ok = { ok: true } as const;

/**
 * Teammates and their suggested instructions, as the web app changes them
 * (`workerContract.teammates` and `workerContract.proposals`).
 */
export function teammateRoutes(teammates: BotService, executor: WorkspaceSync) {
  return {
    teammates: {
      create: os.teammates.create.handler(({ input }) => teammates.create(input)),
      update: os.teammates.update.handler(({ input }) =>
        teammates.update(input.teammateId, input.changes, input.expected_revision),
      ),
      export: os.teammates.export.handler(({ input }) => teammates.exportBundle(input.teammateId)),
      duplicate: os.teammates.duplicate.handler(({ input }) =>
        teammates.duplicate(input.teammateId, input.name, input.copyMemory),
      ),
      import: os.teammates.import.handler(({ input }) => teammates.importBundle(input.bundle)),
      setLead: os.teammates.setLead.handler(async ({ input }) => {
        await teammates.setLead(input.teammateId);
        return ok;
      }),
      archive: os.teammates.archive.handler(async ({ input }) => {
        await teammates.archive(input.teammateId);
        return ok;
      }),
      setBudget: os.teammates.setBudget.handler(async ({ input }) => {
        await teammates.setBudget(input.teammateId, input.budget, input.autoApprove);
        return ok;
      }),
      sync: os.teammates.sync.handler(async ({ input }) => {
        await executor.syncWorkspace(await teammates.findTeammate(input.teammateId));
        return ok;
      }),
    },
    proposals: {
      accept: os.proposals.accept.handler(async ({ input }) => {
        await teammates.acceptProposal(input.proposalId);
        return ok;
      }),
      dismiss: os.proposals.dismiss.handler(async ({ input }) => {
        await teammates.dismissProposal(input.proposalId);
        return ok;
      }),
    },
  };
}
