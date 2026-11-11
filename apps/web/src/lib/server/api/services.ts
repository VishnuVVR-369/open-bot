import "server-only";

/** The API's operations, behind its procedures. */
export { decideApproval, getApproval, listApprovalRules, removeApprovalRule } from "./approvals";
export { removeSchedule, setCheckIn, testWebhook } from "./automations";
export {
  archiveChat,
  createGroupChat,
  markChatRead,
  newDirectChat,
  renameChat,
  sendMessage,
} from "./chats";
export {
  getEgressStatus,
  listEgressDevices,
  registerEgressDevice,
  revokeEgressDevice,
  setEgressMode,
  setPhoneEgressMode,
} from "./egress";
export { getHome } from "./home";
export {
  removeConnection,
  removeEmailToken,
  saveAccountConnection,
  saveConnection,
  saveEmailSettings,
  saveOAuthClient,
  setConnectionEnabled,
  startAccountConnect,
  testConnection,
} from "./integrations";
export { confirmMemory, createMemory, forgetMemory, restoreMemory, updateMemory } from "./memory";
export { markNotificationsRead } from "./notifications";
export { getPage, listPages, openPage, pinPage, removePage } from "./pages";
export { registerPushDevice, sendTestPush, unregisterPushDevice } from "./push";
export { removeApiKey, saveApiKey, setMonthlyCap, setTimezone } from "./settings";
export { cancelRun, giveFeedback, rateRun, retryRun, stopSwarm } from "./runs";
export {
  acceptProposal,
  archiveTeammate,
  createTeammate,
  dismissProposal,
  duplicateTeammate,
  importTeammate,
  setBudget,
  setLead,
  updateTeammate,
} from "./teammates";
export { putUpload, uploadStatus } from "./uploads";
export { removeVaultItem, saveVaultItem } from "./vault";

export * from "./screens";
