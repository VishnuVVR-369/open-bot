import "server-only";
import {
  getAccountsSetup,
  getAppState,
  getChatData,
  getEmailStatus,
  getModelAccess,
  getMonthlyUsage,
  getProfile,
  getSpending,
  listAutomationRuns,
  listBots,
  listChats,
  listConnections,
  listLessons,
  listNotifications,
  listSchedules,
  listTriggers,
  searchMessages,
} from "../queries";
import { worker } from "../worker";
import { ApiError } from "./errors";
import { approvalRoutes } from "@/features/approvals/server";
import { fileRoutes } from "@/features/files/server";
import { memoryRoutes } from "@/features/memory/server";
import { pageRoutes } from "@/features/pages/server";
import { skillRoutes } from "@/features/skills/server";
import { taskRoutes } from "@/features/tasks/server";
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
  screens: {
    list: os.screens.list.handler(() => api.listScreens()),
    frames: os.screens.frames.handler(() => api.lastScreenFrames()),
    takeOver: os.screens.takeOver.handler(({ input }) => api.takeOverScreen(input)),
    handBack: os.screens.handBack.handler(({ input }) => api.handBackScreen(input)),
    wake: os.screens.wake.handler(({ input }) => api.wakeScreen(input)),
    activity: os.screens.activity.handler(({ input }) => api.reportScreenActivity(input)),
  },
  takeovers: {
    dismiss: os.takeovers.dismiss.handler(({ input }) => api.dismissTakeoverRequest(input)),
    codeContext: os.takeovers.codeContext.handler(({ input }) => api.codeContext(input)),
  },
  screenOperations: {
    type: os.screenOperations.type.handler(({ input }) => api.typeOnScreen(input)),
    get: os.screenOperations.get.handler(({ input }) => api.getScreenOperation(input)),
    cancel: os.screenOperations.cancel.handler(({ input }) => api.cancelScreenOperation(input)),
  },
  home: {
    get: os.home.get.handler(({ input, context }) => api.getHome(context.user, input)),
  },
  teammates: {
    list: os.teammates.list.handler(() => listBots()),
    lessons: os.teammates.lessons.handler(({ input }) => listLessons(input.botId)),
    spending: os.teammates.spending.handler(async ({ input }) => {
      const spending = await getSpending(input.botId);
      if (!spending) throw new ApiError("NOT_FOUND", "No such teammate.");
      return spending;
    }),
    create: os.teammates.create.handler(({ input }) => api.createTeammate(input)),
    update: os.teammates.update.handler(({ input }) => api.updateTeammate(input)),
    duplicate: os.teammates.duplicate.handler(({ input }) => api.duplicateTeammate(input)),
    import: os.teammates.import.handler(({ input }) => api.importTeammate(input)),
    setLead: os.teammates.setLead.handler(({ input }) => api.setLead(input)),
    archive: os.teammates.archive.handler(({ input }) => api.archiveTeammate(input)),
    setBudget: os.teammates.setBudget.handler(({ input }) => api.setBudget(input)),
  },
  proposals: {
    accept: os.proposals.accept.handler(({ input }) => api.acceptProposal(input)),
    dismiss: os.proposals.dismiss.handler(({ input }) => api.dismissProposal(input)),
  },
  schedules: {
    list: os.schedules.list.handler(() => listSchedules()),
    runs: os.schedules.runs.handler(({ input }) =>
      listAutomationRuns({ scheduleId: input.scheduleId }),
    ),
    create: os.schedules.create.handler(({ input }) => worker.schedules.create(input)),
    update: os.schedules.update.handler(({ input }) => worker.schedules.update(input)),
    setEnabled: os.schedules.setEnabled.handler(({ input }) => worker.schedules.setEnabled(input)),
    remove: os.schedules.remove.handler(({ input }) => api.removeSchedule(input)),
    runNow: os.schedules.runNow.handler(({ input }) => worker.schedules.runNow(input)),
    setCheckIn: os.schedules.setCheckIn.handler(({ input }) => api.setCheckIn(input)),
  },
  triggers: {
    list: os.triggers.list.handler(() => listTriggers()),
    runs: os.triggers.runs.handler(({ input }) =>
      listAutomationRuns({ triggerId: input.triggerId }),
    ),
    create: os.triggers.create.handler(({ input }) => worker.triggers.create(input)),
    update: os.triggers.update.handler(({ input }) => worker.triggers.update(input)),
    setEnabled: os.triggers.setEnabled.handler(({ input }) => worker.triggers.setEnabled(input)),
    remove: os.triggers.remove.handler(({ input }) => worker.triggers.remove(input)),
    // Looking at a page can take a while.
    check: os.triggers.check.handler(({ input }) =>
      worker.triggers.check(input, { context: { timeoutMs: 45_000 } }),
    ),
    rotateToken: os.triggers.rotateToken.handler(({ input }) => worker.triggers.rotateToken(input)),
    test: os.triggers.test.handler(({ input }) => api.testWebhook(input)),
  },
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
  telegram: {
    status: os.telegram.status.handler(() => worker.telegram.status()),
    connect: os.telegram.connect.handler(({ input }) => worker.telegram.connect(input)),
    linkCode: os.telegram.linkCode.handler(() => worker.telegram.linkCode()),
    sendTest: os.telegram.sendTest.handler(() => worker.telegram.sendTest()),
    unlink: os.telegram.unlink.handler(() => worker.telegram.unlink()),
    disconnect: os.telegram.disconnect.handler(() => worker.telegram.disconnect()),
  },
  chatgpt: {
    setAuthSource: os.chatgpt.setAuthSource.handler(({ input }) =>
      worker.codex.setAuthSource(input),
    ),
    startLogin: os.chatgpt.startLogin.handler(() => worker.codex.deviceLogin()),
    signOut: os.chatgpt.signOut.handler(() => worker.codex.logout()),
  },
  settings: {
    modelAccess: os.settings.modelAccess.handler(() => getModelAccess()),
    usage: os.settings.usage.handler(() => getMonthlyUsage()),
    rateLimits: os.settings.rateLimits.handler(
      async () => (await worker.codex.rateLimits()).rateLimits,
    ),
    setTimezone: os.settings.setTimezone.handler(({ input }) => api.setTimezone(input)),
    saveApiKey: os.settings.saveApiKey.handler(({ input }) => api.saveApiKey(input)),
    removeApiKey: os.settings.removeApiKey.handler(() => api.removeApiKey()),
    setMonthlyCap: os.settings.setMonthlyCap.handler(({ input }) => api.setMonthlyCap(input)),
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
  push: {
    status: os.push.status.handler(() => worker.push.status()),
    registerDevice: os.push.registerDevice.handler(({ input }) => api.registerPushDevice(input)),
    unregisterDevice: os.push.unregisterDevice.handler(({ input }) =>
      api.unregisterPushDevice(input),
    ),
    test: os.push.test.handler(() => api.sendTestPush()),
    subscribe: os.push.subscribe.handler(({ input }) => worker.push.subscribe(input)),
    unsubscribe: os.push.unsubscribe.handler(({ input }) => worker.push.unsubscribe(input)),
  },
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
