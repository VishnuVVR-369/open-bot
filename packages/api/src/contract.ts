import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";
import { appContract, homeContract } from "./contracts/home";
import { screensContract, takeoversContract, screenOperationsContract } from "./contracts/screens";
import { teammatesContract, proposalsContract } from "./contracts/teammates";
import { schedulesContract, triggersContract } from "./contracts/automations";
import { skillsContract } from "./contracts/skills";
import { tasksContract } from "./contracts/tasks";
import { vaultContract } from "./contracts/vault";
import { profileContract, chatgptContract, settingsContract } from "./contracts/settings";
import { memoryContract } from "./contracts/memory";
import { filesContract } from "./contracts/files";
import {
  connectionsContract,
  accountsContract,
  emailContract,
  telegramContract,
} from "./contracts/integrations";
import { chatsContract, runsContract, swarmsContract, searchContract } from "./contracts/chat";
import { uploadsContract } from "./contracts/uploads";
import { notificationsContract } from "./contracts/notifications";
import { pagesContract } from "./contracts/pages";
import { egressContract } from "./contracts/egress";
import { pushContract } from "./contracts/push";
import { approvalsContract } from "./contracts/approvals";

export { API_ERRORS } from "./base";
export { MAX_TEAMMATE_FILE } from "./contracts/teammates";
export {
  MAX_GROUP_TEAMMATES,
  sendMessageInputSchema,
  type SendMessageInput,
  chatTitleSchema,
  groupTeammatesSchema,
  feedbackInputSchema,
} from "./contracts/chat";
export { decideApprovalInputSchema } from "./contracts/approvals";

/**
 * The open-bot API, shared by the web app (which implements it at `/api/rpc`, and reads through
 * it in the browser) and the phone (which calls it). Only the contract lives here, never server
 * code, so the phone can import it.
 *
 * Every procedure needs the owner's session. Retryable operations take a client-generated id; a
 * retry with the same id returns the first result, and the same id with a different request is a
 * `CONFLICT`.
 */
export const contract = {
  app: appContract,
  screens: screensContract,
  takeovers: takeoversContract,
  screenOperations: screenOperationsContract,
  home: homeContract,
  teammates: teammatesContract,
  proposals: proposalsContract,
  schedules: schedulesContract,
  triggers: triggersContract,
  skills: skillsContract,
  tasks: tasksContract,
  vault: vaultContract,
  profile: profileContract,
  memory: memoryContract,
  files: filesContract,
  connections: connectionsContract,
  accounts: accountsContract,
  email: emailContract,
  telegram: telegramContract,
  chatgpt: chatgptContract,
  settings: settingsContract,
  chats: chatsContract,
  runs: runsContract,
  swarms: swarmsContract,
  uploads: uploadsContract,
  notifications: notificationsContract,
  pages: pagesContract,
  search: searchContract,
  approvals: approvalsContract,
  egress: egressContract,
  push: pushContract,
};

export type Contract = typeof contract;

/** What each procedure takes, as callers write it. */
export type ApiInputs = InferContractRouterInputs<Contract>;
/** What each procedure returns. */
export type ApiOutputs = InferContractRouterOutputs<Contract>;
