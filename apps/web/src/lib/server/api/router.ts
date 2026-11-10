import "server-only";
import { API_ERRORS, contract } from "@open-bot/api";
import { MemoryError } from "@open-bot/memory";
import { implement, ORPCError, ValidationError } from "@orpc/server";
import { z } from "zod";
import { auth } from "../auth";
import {
  getAccountsSetup,
  getAppState,
  getChatData,
  getEmailStatus,
  getModelAccess,
  getMonthlyUsage,
  getProfile,
  getSpending,
  listApprovals,
  listAutomationRuns,
  listBots,
  listChats,
  listConnections,
  listLessons,
  listNotifications,
  listSchedules,
  listSkills,
  listTasks,
  listTriggers,
  listVaultItems,
  searchMessages,
} from "../queries";
import { worker, WorkerError } from "../worker";
import { ApiError } from "./errors";
import { listMemories, memoriesForRun, memoryHistory } from "./memory";
import { searchPages } from "./pages";
import * as api from "./services";

export interface RpcContext {
  headers: Headers;
}

/** The code for a failure that only has an HTTP status, from the worker or the memory store. */
const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  503: "SERVICE_UNAVAILABLE",
};

/** Errors as callers see them: the same messages the web shows, with a code to act on. */
function toRpcError(error: unknown): ORPCError<string, unknown> {
  // Input the contract refused: say what the schema says ("Name the chat."), not that it failed.
  if (
    error instanceof ORPCError &&
    error.code === "BAD_REQUEST" &&
    error.cause instanceof ValidationError
  )
    return new ORPCError("BAD_REQUEST", {
      message: error.cause.issues.map((issue) => issue.message).join(". "),
      data: error.data,
      cause: error.cause,
    });
  if (error instanceof ORPCError) return error;
  if (error instanceof ApiError) {
    // A defined error only counts as one with the status the contract gives it.
    const status = error.code === "BAD_REQUEST" ? 400 : API_ERRORS[error.code].status;
    return new ORPCError(error.code, {
      status,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    });
  }
  if (error instanceof z.ZodError)
    return new ORPCError("BAD_REQUEST", { message: error.issues.map((i) => i.message).join(". ") });
  if (error instanceof WorkerError || error instanceof MemoryError) {
    const code = STATUS_CODES[error.status] ?? "INTERNAL_SERVER_ERROR";
    // A 409 here is a state conflict, not a reused id: don't let it pass as the defined CONFLICT.
    return new ORPCError(code === "CONFLICT" ? "STATE_CONFLICT" : code, {
      status: error.status,
      message: error.message,
    });
  }
  console.error("rpc failed", error);
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    message: error instanceof Error ? error.message : String(error),
  });
}

const os = implement(contract)
  .$context<RpcContext>()
  .use(async ({ context, next }) => {
    const session = await auth.api.getSession({ headers: context.headers });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
    try {
      return await next({ context: { user: session.user } });
    } catch (error) {
      throw toRpcError(error);
    }
  });

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
  },
  schedules: {
    list: os.schedules.list.handler(() => listSchedules()),
    runs: os.schedules.runs.handler(({ input }) =>
      listAutomationRuns({ scheduleId: input.scheduleId }),
    ),
  },
  triggers: {
    list: os.triggers.list.handler(() => listTriggers()),
    runs: os.triggers.runs.handler(({ input }) =>
      listAutomationRuns({ triggerId: input.triggerId }),
    ),
  },
  skills: {
    list: os.skills.list.handler(() => listSkills()),
  },
  tasks: {
    list: os.tasks.list.handler(() => listTasks()),
  },
  vault: {
    list: os.vault.list.handler(() => listVaultItems()),
  },
  profile: {
    get: os.profile.get.handler(() => getProfile()),
  },
  memory: {
    list: os.memory.list.handler(({ input }) => listMemories(input)),
    history: os.memory.history.handler(({ input }) => memoryHistory(input)),
    forRun: os.memory.forRun.handler(({ input }) => memoriesForRun(input)),
  },
  files: {
    list: os.files.list.handler(({ input }) => worker.files.list({ path: input.path })),
  },
  connections: {
    list: os.connections.list.handler(() => listConnections()),
  },
  accounts: {
    setup: os.accounts.setup.handler(() => getAccountsSetup()),
  },
  email: {
    status: os.email.status.handler(() => getEmailStatus()),
  },
  telegram: {
    status: os.telegram.status.handler(() => worker.telegram.status()),
  },
  settings: {
    modelAccess: os.settings.modelAccess.handler(() => getModelAccess()),
    usage: os.settings.usage.handler(() => getMonthlyUsage()),
    rateLimits: os.settings.rateLimits.handler(
      async () => (await worker.codex.rateLimits()).rateLimits,
    ),
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
  pages: {
    list: os.pages.list.handler(() => api.listPages()),
    search: os.pages.search.handler(({ input }) => searchPages(input.query)),
    get: os.pages.get.handler(({ input }) => api.getPage(input.pageId)),
    open: os.pages.open.handler(({ input }) => api.openPage(input)),
    pin: os.pages.pin.handler(({ input }) => api.pinPage(input)),
    remove: os.pages.remove.handler(({ input }) => api.removePage(input)),
  },
  search: {
    messages: os.search.messages.handler(({ input }) => searchMessages(input.query)),
  },
  approvals: {
    list: os.approvals.list.handler(() => listApprovals()),
    get: os.approvals.get.handler(({ input }) => api.getApproval(input.approvalId)),
    decide: os.approvals.decide.handler(({ input }) => api.decideApproval(input)),
    rules: os.approvals.rules.handler(() => api.listApprovalRules()),
    removeRule: os.approvals.removeRule.handler(({ input }) => api.removeApprovalRule(input)),
  },
  push: {
    status: os.push.status.handler(() => worker.push.status()),
    registerDevice: os.push.registerDevice.handler(({ input }) => api.registerPushDevice(input)),
    unregisterDevice: os.push.unregisterDevice.handler(({ input }) =>
      api.unregisterPushDevice(input),
    ),
    test: os.push.test.handler(() => api.sendTestPush()),
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
