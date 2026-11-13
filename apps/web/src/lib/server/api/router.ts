import "server-only";
import {
  getAccountsSetup,
  getAppState,
  getChatData,
  getEmailStatus,
  getProfile,
  listChats,
  listConnections,
  listNotifications,
  searchMessages,
} from "../queries";
import { ApiError } from "./errors";
import { approvalRoutes } from "@/features/approvals/server";
import { automationRoutes } from "@/features/automations/server";
import { computerRoutes } from "@/features/computer/server";
import { fileRoutes } from "@/features/files/server";
import { homeRoutes } from "@/features/home/server";
import { memoryRoutes } from "@/features/memory/server";
import { pageRoutes } from "@/features/pages/server";
import { settingsRoutes } from "@/features/settings/server";
import { skillRoutes } from "@/features/skills/server";
import { taskRoutes } from "@/features/tasks/server";
import { teammateRoutes } from "@/features/teammates/server";
import { vaultRoutes } from "@/features/vault/server";
import { os } from "./rpc";
import * as api from "./services";

/** The API (`contract` in `@open-bot/api`), for the browser and the phone. */
export const router = os.router({
  app: {
    state: os.app.state.handler(({ context }) =>
      getAppState({ name: context.user.name, email: context.user.email }),
    ),
  },
  ...computerRoutes(),
  home: homeRoutes(),
  ...teammateRoutes(),
  ...settingsRoutes(),
  ...automationRoutes(),
  skills: skillRoutes(),
  tasks: taskRoutes(),
  vault: vaultRoutes(),
  profile: {
    get: os.profile.get.handler(() => getProfile()),
  },
  memory: memoryRoutes(),
  files: fileRoutes(),
  connections: {
    list: os.connections.list.handler(() => listConnections()),
    save: os.connections.save.handler(({ input }) => api.saveConnection(input)),
    setEnabled: os.connections.setEnabled.handler(({ input }) => api.setConnectionEnabled(input)),
    remove: os.connections.remove.handler(({ input }) => api.removeConnection(input)),
    test: os.connections.test.handler(({ input }) => api.testConnection(input)),
  },
  accounts: {
    setup: os.accounts.setup.handler(() => getAccountsSetup()),
    saveClient: os.accounts.saveClient.handler(({ input }) => api.saveOAuthClient(input)),
    connect: os.accounts.connect.handler(({ input, context }) =>
      api.startAccountConnect(input, context.sessionId),
    ),
    update: os.accounts.update.handler(({ input }) => api.saveAccountConnection(input)),
  },
  email: {
    status: os.email.status.handler(() => getEmailStatus()),
    save: os.email.save.handler(({ input }) => api.saveEmailSettings(input)),
    removeToken: os.email.removeToken.handler(() => api.removeEmailToken()),
  },
  chats: {
    list: os.chats.list.handler(() => listChats()),
    get: os.chats.get.handler(async ({ input }) => {
      const data = await getChatData(input.chatId, input.before);
      if (!data) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
      return data;
    }),
    newDirect: os.chats.newDirect.handler(({ input }) => api.newDirectChat(input)),
    createGroup: os.chats.createGroup.handler(({ input }) => api.createGroupChat(input)),
    rename: os.chats.rename.handler(({ input }) => api.renameChat(input)),
    archive: os.chats.archive.handler(({ input }) => api.archiveChat(input)),
    makeMain: os.chats.makeMain.handler(({ input }) => api.makeMainChat(input)),
    markRead: os.chats.markRead.handler(({ input }) => api.markChatRead(input)),
    send: os.chats.send.handler(({ input }) => api.sendMessage(input)),
  },
  runs: {
    retry: os.runs.retry.handler(({ input }) => api.retryRun(input)),
    cancel: os.runs.cancel.handler(({ input }) => api.cancelRun(input)),
    rate: os.runs.rate.handler(({ input }) => api.rateRun(input)),
    feedback: os.runs.feedback.handler(({ input }) => api.giveFeedback(input)),
  },
  swarms: {
    stop: os.swarms.stop.handler(({ input }) => api.stopSwarm(input)),
  },
  uploads: {
    status: os.uploads.status.handler(({ input }) => api.uploadStatus(input.uploadId)),
  },
  notifications: {
    list: os.notifications.list.handler(() => listNotifications()),
    markRead: os.notifications.markRead.handler(({ input }) => api.markNotificationsRead(input)),
  },
  pages: pageRoutes(),
  search: {
    messages: os.search.messages.handler(({ input }) => searchMessages(input.query)),
  },
  approvals: approvalRoutes(),
  egress: {
    status: os.egress.status.handler(() => api.getEgressStatus()),
    setMode: os.egress.setMode.handler(({ input }) => api.setEgressMode(input)),
    setPhoneMode: os.egress.setPhoneMode.handler(({ input }) => api.setPhoneEgressMode(input)),
    devices: os.egress.devices.handler(() => api.listEgressDevices()),
    registerDevice: os.egress.registerDevice.handler(({ input }) =>
      api.registerEgressDevice(input),
    ),
    revokeDevice: os.egress.revokeDevice.handler(({ input }) => api.revokeEgressDevice(input)),
  },
});
