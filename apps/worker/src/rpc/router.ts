import type { Context } from "../context";
import { os } from "../core/rpc";
import { taskRoutes, type TaskService } from "../features/tasks";
import type { EgressRelay } from "../egress/relay";
import type { WakeController } from "../egress/wake";
import type { UploadService } from "../uploads";
import type { RunExecutor } from "../runs/executor";
import { approvalRoutes, type ApprovalService } from "../features/approvals";
import { teammateRoutes, type BotService } from "../features/teammates";
import type { CodexAccountService } from "../services/codex-account";
import type { SettingsService } from "../services/settings";
import type { ConnectionService } from "../services/connections";
import type { EmailService } from "../services/email";
import type { FcmService } from "../services/fcm";
import type { FileService } from "../services/files";
import { pageRoutes, type PageService } from "../features/pages";
import type { PushService } from "../services/push";
import type { RetryService } from "../services/retries";
import { withScreenLock } from "../services/screen-lock";
import type { ScreenOperationService } from "../services/screen-operations";
import type { SkillService } from "../services/skills";
import type { SwarmService } from "../services/swarms";
import type { TakeoverService } from "../services/takeovers";
import { chatRoutes, type ChatService } from "../features/chat";
import type { RunRequests } from "../runs/requests";
import type { TelegramService } from "../services/telegram";
import {
  automationRoutes,
  type AccountTriggers,
  type ScheduleService,
  type TriggerService,
} from "../features/automations";
import { rpcError } from "./errors";
import type { EgressDevices } from "../egress/devices";
import { markNotificationsRead } from "../services/notifications";
import type { VaultService } from "../services/vault";

/** The services the worker's internal API calls. */
export interface WorkerServices {
  ctx: Context;
  teammates: BotService;
  chats: ChatService;
  runRequests: RunRequests;
  executor: RunExecutor;
  retries: RetryService;
  approvals: ApprovalService;
  takeovers: TakeoverService;
  screenOperations: ScreenOperationService;
  files: FileService;
  pages: PageService;
  uploads: UploadService;
  schedules: ScheduleService;
  push: PushService;
  fcm: FcmService;
  tasks: TaskService;
  email: EmailService;
  connections: ConnectionService;
  swarms: SwarmService;
  triggers: TriggerService;
  accountTriggers: AccountTriggers;
  telegram: TelegramService;
  skills: SkillService;
  codexAccount: CodexAccountService;
  settings: SettingsService;
  vault: VaultService;
  egress: EgressRelay;
  egressDevices: EgressDevices;
  wake: WakeController;
}

const ok = { ok: true } as const;

/**
 * The worker's internal API (`workerContract`). Each procedure only calls services: a rule about
 * what is allowed, or how it is done, belongs in the service, where the teammates' tools use it
 * too. Waking the computer and turning errors into statuses happen around every procedure, in
 * `createRpcHandler`.
 */
export function createWorkerRouter(services: WorkerServices) {
  const s = services;
  const { ctx } = s;

  /** A screen is a teammate's, so its id must be one. */
  const screenOf = async (id: string) => (await s.teammates.findTeammate(id)).id;

  return os.router({
    status: {
      get: os.status.get.handler(() => ({
        computer: {
          online: ctx.computer.online,
          health: ctx.computer.health,
          lifecycle: ctx.lifecycle?.status ?? null,
        },
        codex: ctx.codex.status,
        egress: s.egress.status,
      })),
    },
    ...teammateRoutes(s.teammates, s.executor),
    ...automationRoutes(s.schedules, s.triggers, s.accountTriggers),
    chats: chatRoutes(s.chats),
    messages: {
      dispatch: os.messages.dispatch.handler(async ({ input }) => {
        await s.executor.dispatchMessage(input.messageId);
        return ok;
      }),
    },
    runs: {
      retry: os.runs.retry.handler(({ input }) => s.retries.retry(input.runId)),
      processCancellations: os.runs.processCancellations.handler(async () => {
        await s.executor.processCancellations();
        return ok;
      }),
      stop: os.runs.stop.handler(async ({ input }) => {
        await s.runRequests.stop(input.runId);
        return ok;
      }),
      rate: os.runs.rate.handler(async ({ input }) => {
        await s.runRequests.rate(input.runId, input.rating);
        return ok;
      }),
      feedback: os.runs.feedback.handler(async ({ input }) => {
        await s.runRequests.feedback(input);
        return ok;
      }),
    },
    approvals: approvalRoutes(s.approvals),
    screens: {
      wake: os.screens.wake.handler(async ({ input }) => {
        await ctx.computer.startScreen(await screenOf(input.screenId));
        return ok;
      }),
      forget: os.screens.forget.handler(async ({ input }) => {
        await ctx.computer.forgetScreen(await screenOf(input.screenId));
        return ok;
      }),
      take: os.screens.take.handler(async ({ input }) => {
        const id = await screenOf(input.screenId);
        await withScreenLock(ctx, id, () => s.takeovers.take(id));
        return ok;
      }),
      handBack: os.screens.handBack.handler(async ({ input }) => {
        const id = await screenOf(input.screenId);
        await withScreenLock(ctx, id, () =>
          s.takeovers.handBack(id, input.note ?? null, input.clearCode),
        );
        return ok;
      }),
      touch: os.screens.touch.handler(async ({ input }) => {
        await ctx.computer.touchUser(await screenOf(input.screenId));
        return ok;
      }),
      typeCode: os.screens.typeCode.handler(({ input }) => s.screenOperations.type(input)),
    },
    screenOperations: {
      get: os.screenOperations.get.handler(({ input }) =>
        s.screenOperations.get(input.operationId),
      ),
      cancel: os.screenOperations.cancel.handler(({ input }) =>
        s.screenOperations.cancel(input.operationId),
      ),
    },
    takeovers: {
      codeContext: os.takeovers.codeContext.handler(({ input }) =>
        s.screenOperations.context(input.takeoverId),
      ),
      dismiss: os.takeovers.dismiss.handler(async ({ input }) => {
        await s.takeovers.dismiss(input.takeoverId);
        return ok;
      }),
    },
    files: {
      list: os.files.list.handler(({ input }) => s.files.list(input.path)),
      read: os.files.read.handler(({ input }) => s.files.read(input.path)),
      write: os.files.write.handler(async ({ input }) => {
        await s.files.write(input.path, input.dataBase64);
        return ok;
      }),
      put: os.files.put.handler(async ({ input }) => ({
        path: await s.files.put(input.dir, input.name, input.dataBase64),
      })),
      remove: os.files.remove.handler(async ({ input }) => {
        await s.files.remove(input.path);
        return ok;
      }),
    },
    pages: pageRoutes(s.pages),
    uploads: {
      status: os.uploads.status.handler(async ({ input }) => {
        const upload = await s.uploads.status(input.uploadId);
        if (!upload) throw rpcError(404, "That upload isn't here.");
        return upload;
      }),
    },
    push: {
      status: os.push.status.handler(async () => ({
        publicKey: await s.push.publicKey(),
        devices: (await s.push.devices()).map((row) => ({
          endpoint: row.endpoint,
          device: row.device,
          createdAt: row.createdAt.toISOString(),
        })),
      })),
      subscribe: os.push.subscribe.handler(async ({ input }) => {
        await s.push.subscribe(input.subscription, input.device);
        return ok;
      }),
      unsubscribe: os.push.unsubscribe.handler(async ({ input }) => {
        await s.push.unsubscribe(input.endpoint);
        return ok;
      }),
      test: os.push.test.handler(async () => {
        const [browsers, phones] = await Promise.all([
          s.push.sendAll({
            title: "open-bot",
            body: "Notifications work on this device.",
            url: "/settings#notifications",
            tag: "push-test",
          }),
          s.fcm.sendAll({
            data: {
              type: "notification",
              kind: "test",
              title: "open-bot",
              body: "Notifications work on this phone.",
              tag: "push-test",
              url: "/",
            },
            priority: "normal",
          }),
        ]);
        return { sent: browsers + phones };
      }),
      registerNative: os.push.registerNative.handler(async ({ input }) => {
        await s.fcm.register(input);
        return ok;
      }),
      unregisterNative: os.push.unregisterNative.handler(async ({ input }) => {
        await s.fcm.unregister(input.token);
        return ok;
      }),
    },
    tasks: taskRoutes(s.tasks),
    email: {
      inbound: os.email.inbound.handler(async ({ input }) => ({
        ok: true as const,
        ...(await s.email.inbound(input.params.token, input.body)),
      })),
      status: os.email.status.handler(() => s.email.status()),
      save: os.email.save.handler(async ({ input }) => {
        await s.email.saveSettings(input);
        return ok;
      }),
      removeToken: os.email.removeToken.handler(async () => {
        await s.email.removeToken();
        return ok;
      }),
    },
    vault: {
      save: os.vault.save.handler(({ input }) => s.vault.saveItem(input)),
      remove: os.vault.remove.handler(async ({ input }) => {
        await s.vault.removeItem(input.itemId);
        return ok;
      }),
    },
    notifications: {
      markRead: os.notifications.markRead.handler(async ({ input }) => {
        await markNotificationsRead(ctx, input);
        return ok;
      }),
    },
    settings: {
      setTimezone: os.settings.setTimezone.handler(async ({ input }) => {
        await s.settings.setTimezone(input.timezone);
        return ok;
      }),
      setMonthlyCap: os.settings.setMonthlyCap.handler(async ({ input }) => {
        await s.settings.setMonthlyCap(input.dollars);
        return ok;
      }),
      saveApiKey: os.settings.saveApiKey.handler(async ({ input }) => {
        await s.settings.saveApiKey(input.apiKey);
        return ok;
      }),
      removeApiKey: os.settings.removeApiKey.handler(async () => {
        await s.settings.removeApiKey();
        return ok;
      }),
    },
    connections: {
      save: os.connections.save.handler(({ input }) => s.connections.saveMcp(input)),
      setEnabled: os.connections.setEnabled.handler(async ({ input }) => {
        await s.connections.setEnabled(input.connectionId, input.enabled);
        return ok;
      }),
      remove: os.connections.remove.handler(({ input }) =>
        s.connections.remove(input.connectionId),
      ),
      updateAccount: os.connections.updateAccount.handler(({ input }) =>
        s.connections.updateAccount(input),
      ),
      linkAccount: os.connections.linkAccount.handler(({ input }) =>
        s.connections.linkAccount(input),
      ),
      test: os.connections.test.handler(({ input }) => s.connections.test(input.connectionId)),
    },
    swarms: {
      stop: os.swarms.stop.handler(async ({ input }) => {
        await s.swarms.stop(input.swarmId);
        return ok;
      }),
    },
    telegram: {
      status: os.telegram.status.handler(() => s.telegram.status()),
      connect: os.telegram.connect.handler(({ input }) => s.telegram.connect(input.token)),
      linkCode: os.telegram.linkCode.handler(() => s.telegram.linkCode()),
      sendTest: os.telegram.sendTest.handler(async () => {
        await s.telegram.sendTest();
        return ok;
      }),
      unlink: os.telegram.unlink.handler(async () => {
        await s.telegram.unlink();
        return ok;
      }),
      disconnect: os.telegram.disconnect.handler(async () => {
        await s.telegram.disconnect();
        return ok;
      }),
    },
    skills: {
      save: os.skills.save.handler(async ({ input: { id, ...skill } }) => ({
        id: (await s.skills.save(skill, { kind: "user" }, id ?? undefined)).id,
      })),
      remove: os.skills.remove.handler(async ({ input }) => {
        await s.skills.remove(input.skillId);
        return ok;
      }),
    },
    codex: {
      deviceLogin: os.codex.deviceLogin.handler(() => ctx.codex.startDeviceLogin()),
      setAuthSource: os.codex.setAuthSource.handler(({ input }) =>
        s.codexAccount.setAuthSource(input.source),
      ),
      logout: os.codex.logout.handler(async () => {
        await s.codexAccount.logout();
        return ok;
      }),
      rateLimits: os.codex.rateLimits.handler(async () => {
        const limits = await ctx.codex.rateLimits();
        if (!limits) return { rateLimits: null };
        const { primary, secondary } = limits.rateLimits;
        return { rateLimits: { rateLimits: { primary, secondary } } };
      }),
    },
    egress: {
      setMode: os.egress.setMode.handler(async ({ input }) => {
        await s.egress.setMode(input.mode);
        return ok;
      }),
      setPhoneMode: os.egress.setPhoneMode.handler(async ({ input }) => {
        await s.egress.setPhoneMode(input.mode);
        return ok;
      }),
      devicesChanged: os.egress.devicesChanged.handler(async () => {
        await s.egress.reloadPhones();
        return ok;
      }),
      deviceUnavailable: os.egress.deviceUnavailable.handler(({ input }) => {
        // Only from the pairing that is current: an old one can't silence a new one.
        const phone = s.egress.pairedPhones.find((row) => row.id === input.deviceId);
        if (phone?.generation === input.generation)
          s.wake.unavailable(input.deviceId, input.reason, input.seq);
        return ok;
      }),
      deviceRevoked: os.egress.deviceRevoked.handler(async ({ input }) => {
        await s.egress.revoke(input.deviceId, input.generation);
        return ok;
      }),
      pairDevice: os.egress.pairDevice.handler(({ input }) => s.egressDevices.pair(input)),
      unpairDevice: os.egress.unpairDevice.handler(async ({ input }) => {
        await s.egressDevices.unpair(input.deviceId, input.generation);
        return ok;
      }),
      devicePushToken: os.egress.devicePushToken.handler(async ({ input }) => {
        await s.egressDevices.setPushToken(input.deviceId, input.token);
        return ok;
      }),
      deviceUsed: os.egress.deviceUsed.handler(async ({ input }) => {
        await s.egressDevices.markUsed(input.deviceId);
        return ok;
      }),
    },
  });
}

export type WorkerRouter = ReturnType<typeof createWorkerRouter>;
