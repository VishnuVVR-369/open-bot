import type { Context } from "../context";
import { os } from "../core/rpc";
import { taskRoutes, type TaskService } from "../features/tasks";
import type { EgressRelay } from "../egress/relay";
import type { WakeController } from "../egress/wake";
import { uploadsRoutes, type UploadService } from "../features/uploads";
import type { RunExecutor } from "../runs/executor";
import { approvalRoutes, type ApprovalService } from "../features/approvals";
import { teammateRoutes, type BotService } from "../features/teammates";
import { codexAccountRoutes, type CodexAccountService } from "../features/codex-account";
import { settingsRoutes, type SettingsService } from "../features/settings";
import { connectionsRoutes, type ConnectionService } from "../features/connections";
import { emailRoutes, type EmailService } from "../features/email";
import { filesRoutes, type FileService } from "../features/files";
import { pageRoutes, type PageService } from "../features/pages";
import { notificationRoutes, type FcmService, type PushService } from "../features/notifications";
import type { RetryService } from "../runs/retries";
import {
  screenRoutes,
  type ScreenOperationService,
  type TakeoverService,
} from "../features/screens";
import { skillRoutes, type SkillService } from "../features/skills";
import { swarmRoutes, type SwarmService } from "../features/teamwork";
import { chatRoutes, type ChatService } from "../features/chat";
import type { RunRequests } from "../runs/requests";
import { telegramRoutes, type TelegramService } from "../features/telegram";
import {
  automationRoutes,
  type AccountTriggers,
  type ScheduleService,
  type TriggerService,
} from "../features/automations";
import type { EgressDevices } from "../egress/devices";
import { vaultRoutes, type VaultService } from "../features/vault";

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
    ...screenRoutes(ctx, s.teammates, s.takeovers, s.screenOperations),
    files: filesRoutes(s.files),
    pages: pageRoutes(s.pages),
    uploads: uploadsRoutes(s.uploads),
    ...notificationRoutes(ctx, s.push, s.fcm),
    tasks: taskRoutes(s.tasks),
    email: emailRoutes(s.email),
    vault: vaultRoutes(s.vault),
    settings: settingsRoutes(s.settings),
    connections: connectionsRoutes(s.connections),
    swarms: swarmRoutes(s.swarms),
    telegram: telegramRoutes(s.telegram),
    skills: skillRoutes(s.skills),
    codex: codexAccountRoutes(ctx, s.codexAccount),
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
