import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";
import { statusContract } from "./contracts/status";
import { teammatesContract, proposalsContract } from "./contracts/teammates";
import { chatsContract, messagesContract, runsContract, swarmsContract } from "./contracts/chat";
import { approvalsContract } from "./contracts/approvals";
import { screensContract, screenOperationsContract, takeoversContract } from "./contracts/screens";
import { filesContract } from "./contracts/files";
import { pagesContract } from "./contracts/pages";
import { uploadsContract } from "./contracts/uploads";
import { schedulesContract, triggersContract, hooksContract } from "./contracts/automations";
import { pushContract, notificationsContract } from "./contracts/notifications";
import { tasksContract } from "./contracts/tasks";
import { emailContract, connectionsContract, telegramContract } from "./contracts/integrations";
import { vaultContract } from "./contracts/vault";
import { settingsContract, codexContract } from "./contracts/settings";
import { egressContract } from "./contracts/egress";
import { skillsContract } from "./contracts/skills";

export type { WorkerMeta } from "./base";
// The owner's inputs, shared with the app's API; still exported here for the worker.
export {
  scheduleInputSchema,
  triggerInputSchema,
  type ScheduleInput,
  type TriggerInput,
} from "../automations";
/**
 * The worker's internal API, which only the web app (and tests) call, with the shared
 * `x-worker-secret` header. The worker implements it in `apps/worker/src/rpc/router.ts` and the
 * web app calls it with `createWorkerClient`.
 *
 * Each procedure has a fixed REST path under `/internal`, and its input is the path parameters
 * merged with the JSON body (or the query string for GET). The paths are part of the contract:
 * during a deploy the web app and the worker can run different versions, so a path or an input
 * field is only removed after no deployed web app calls it.
 *
 * Errors are JSON `{ error, code }` with the HTTP status; `error` is a message to show the owner.
 */
export const workerContract = {
  status: statusContract,
  teammates: teammatesContract,
  proposals: proposalsContract,
  chats: chatsContract,
  messages: messagesContract,
  runs: runsContract,
  approvals: approvalsContract,
  screens: screensContract,
  screenOperations: screenOperationsContract,
  takeovers: takeoversContract,
  files: filesContract,
  pages: pagesContract,
  uploads: uploadsContract,
  schedules: schedulesContract,
  push: pushContract,
  tasks: tasksContract,
  email: emailContract,
  vault: vaultContract,
  notifications: notificationsContract,
  settings: settingsContract,
  connections: connectionsContract,
  swarms: swarmsContract,
  triggers: triggersContract,
  hooks: hooksContract,
  telegram: telegramContract,
  skills: skillsContract,
  codex: codexContract,
  egress: egressContract,
};

export type WorkerContract = typeof workerContract;
/** What each worker procedure takes, as callers write it. */
export type WorkerInputs = InferContractRouterInputs<WorkerContract>;
/** What each worker procedure returns. */
export type WorkerOutputs = InferContractRouterOutputs<WorkerContract>;
