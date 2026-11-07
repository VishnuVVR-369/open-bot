import { CHANNELS, computers, createDb, createPool, settings } from "@open-bot/db";
import { ComputerLifecycle } from "./computer-lifecycle";
import { CodexManager } from "./codex";
import { BotdError, ComputerClient } from "./computer";
import { createNotification, publishApp, type Context } from "./context";
import { databaseStore } from "./egress/store";
import { EgressRelay } from "./egress/relay";
import { WakeController } from "./egress/wake";
import { env } from "./env";
import { createHttpServer } from "./http";
import { computerFiles, UploadService } from "./uploads";
import { PushService } from "./services/push";
import { FcmService, nativeEgressPush } from "./services/fcm";
import { TaskService } from "./services/tasks";
import { ConnectionService } from "./services/connections";
import { EmailService } from "./services/email";
import { SwarmService } from "./services/swarms";
import { VaultService } from "./services/vault";
import { createLogger, errorMessage } from "./logger";
import { RunExecutor } from "./runs/executor";
import { ApprovalService } from "./services/approvals";
import { ModelAccess } from "./services/model-access";
import { SessionRegistry } from "./services/registry";
import { ScheduleService } from "./services/schedules";
import { ScreenOperationService } from "./services/screen-operations";
import { MemoryCoordinator } from "./services/memory";
import { SkillService } from "./services/skills";
import { TakeoverService } from "./services/takeovers";
import { TelegramService } from "./services/telegram";
import { AccountTriggers } from "./services/account-triggers";
import { TriggerService } from "./services/triggers";
import { PageService } from "./services/pages";
import { ToolHandlers } from "./tools/handlers";
import { BotService } from "./services/bots";
import { AccountAccess } from "./accounts/access";
import { AccountActions } from "./accounts/actions";
import { Integrations } from "./accounts/registry";
import { AccountTools } from "./accounts/tools";
import { eq } from "drizzle-orm";
import { EventEmitter } from "node:events";

const log = createLogger();
// A stray rejection should be logged, not take down every running task.
process.on("unhandledRejection", (reason) =>
  log.error("unhandled rejection", { error: errorMessage(reason) }),
);
const pool = createPool(env.DATABASE_URL);
const db = createDb(pool);

// Single-row tables exist from the start.
await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
await db.insert(computers).values({ id: "default" }).onConflictDoNothing();

const computer = new ComputerClient(env.BOTD_URL, env.BOTD_TOKEN, log.child("computer"));
const codex = new CodexManager(
  computer,
  env.HOST_CODEX_AUTH_FILE,
  env.HOST_CODEX_BIN,
  async () => {
    const [row] = await db
      .select({ source: settings.chatgptAuthSource })
      .from(settings)
      .where(eq(settings.id, 1));
    return row?.source ?? "host";
  },
  log.child("codex"),
);
const ctx: Context = { env, db, pool, computer, codex, log, events: new EventEmitter() };

const sessions = new SessionRegistry();
const memory = new MemoryCoordinator(ctx);
await memory.start();
const approvals = new ApprovalService(ctx, sessions);
const takeovers = new TakeoverService(ctx, sessions);
const screenOperations = new ScreenOperationService(ctx, takeovers);
await screenOperations.recover();
const schedules = new ScheduleService(ctx);
const skills = new SkillService(ctx);
const triggers = new TriggerService(ctx);
const tasks = new TaskService(ctx);
const push = new PushService(ctx);
const fcm = new FcmService(ctx);
const vault = new VaultService(ctx, approvals);
const swarms = new SwarmService(ctx, sessions);
// Files you attach, and files that arrive by email or Telegram.
const uploads = new UploadService(db, computerFiles(ctx), log.child("uploads"));
const email = new EmailService(ctx, approvals, sessions, uploads);
const botService = new BotService(ctx, schedules, skills, async (bot) => {
  await memory.store.importLegacy();
  await executor.syncWorkspace(bot);
});
const pages = new PageService(ctx);
const accountAccess = new AccountAccess(ctx);
const integrations = Integrations.create(ctx);
const accountActions = new AccountActions(ctx, sessions, approvals, accountAccess, integrations);
const accountTools = new AccountTools(ctx, accountAccess, accountActions, integrations);
const accountTriggers = new AccountTriggers(ctx, accountAccess, triggers);
const tools = new ToolHandlers(
  ctx,
  approvals,
  takeovers,
  schedules,
  skills,
  triggers,
  tasks,
  vault,
  swarms,
  email,
  memory,
  botService,
  pages,
  accountTools,
);
const model = new ModelAccess(ctx);
const connections = new ConnectionService(ctx, accountTools);
const executor = new RunExecutor(
  ctx,
  sessions,
  tools,
  approvals,
  takeovers,
  model,
  skills,
  connections,
  memory,
  accountAccess,
);
const egress = new EgressRelay({
  store: databaseStore(db),
  computerUrl: () => computer.wsUrl("/egress"),
  log: log.child("egress"),
  publish: () => void publishApp(ctx, { type: "computer" }),
});
const wake = new WakeController({
  now: Date.now,
  relay: egress,
  leasedScreens: () =>
    (computer.health?.screens ?? [])
      .filter((screen) => screen.state !== "paused" && screen.lease !== null)
      .map((screen) => screen.id),
  pushConfigured: () => fcm.configured,
  push: async (phone, stage, phoneMode) => {
    if (!phone.pushToken) return "failed";
    const results = await fcm.sendToTokens(
      [phone.pushToken],
      nativeEgressPush(stage, new Date(), phoneMode),
    );
    return results.get(phone.pushToken) ?? "failed";
  },
  phonesChanged: () => void egress.reloadPhones(),
  notifyUnanswered: () =>
    createNotification(ctx, {
      kind: "egress_unanswered",
      title: "Your phone didn't answer",
      body: "Open open-bot on it so teammates can browse.",
    }),
  publish: () => void publishApp(ctx, { type: "computer" }),
  log: log.child("wake"),
});
egress.setHooks({
  configExtras: () => wake.configExtras(),
  phoneStatus: (id) => wake.phoneStatus(id),
  waiting: () => wake.waiting(),
  onDemand: () => wake.demand(),
  onUnavailable: (id, reason, seq) => wake.unavailable(id, reason, seq),
  onAvailable: (id, seq) => wake.available(id, seq),
  onChange: () => wake.evaluate(),
});
const lifecycle = new ComputerLifecycle(
  env.COMPUTER_LIFECYCLE_ENABLED,
  {
    wake: async (owner, signal) => {
      // Liveness, capability and ensure calls are idempotent. User actions are never retried here.
      for (;;) {
        signal.throwIfAborted();
        try {
          await computer.rawCall("GET", "/healthz", undefined, signal);
          let capabilities: { version: number; enabled: boolean };
          try {
            capabilities = await computer.rawCall(
              "GET",
              "/lifecycle/capabilities",
              undefined,
              signal,
            );
          } catch (error) {
            if (!String(error).includes("returned 404")) throw error;
            log.warn("Computer has no lifecycle capability; retaining eager connections");
            return false;
          }
          if (capabilities.version !== 1 || !capabilities.enabled) {
            log.warn("Computer lifecycle is disabled or incompatible; retaining eager connections");
            return false;
          }
          await computer.rawCall("POST", "/lifecycle/lease", { owner, demand: 1 }, signal);
          await computer.rawCall("POST", "/lifecycle/ensure", { owner }, signal);
          return true;
        } catch (error) {
          if (/returned (401|403|400)/.test(String(error))) throw error;
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              signal.removeEventListener("abort", abort);
              resolve();
            };
            const timer = setTimeout(done, 500);
            const abort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      }
    },
    restore: async (signal) => {
      computer.start();
      await egress.resumeComputer();
      while (
        !computer.online ||
        !egress.computerConnected ||
        !computer.health?.egress.configured ||
        !computer.health.egress.tunnelConnected ||
        computer.health.egress.mode !== egress.currentMode ||
        computer.health.egress.agentOnline !== egress.status.agentOnline
      ) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await codex.resume(signal);
      signal.throwIfAborted();
      if (codex.status.account) {
        await codex.rateLimits(true).catch(() => {});
        await skills.syncAll();
      }
      signal.throwIfAborted();
    },
    quiesce: async (owner) => {
      codex.setIdleIntent(true);
      try {
        await computer.rawCall("POST", "/lifecycle/lease", { owner, demand: 0 });
        await computer.rawCall(
          "POST",
          "/lifecycle/quiesce",
          { owner },
          AbortSignal.timeout(60_000),
        );
        return true;
      } catch (error) {
        codex.setIdleIntent(false);
        // botd answers 409 while work is still running there, such as a download.
        if (error instanceof BotdError && error.status === 409) {
          log.info("computer stays awake: work is still running", { error: errorMessage(error) });
          return false;
        }
        throw error;
      }
    },
    pause: () => {
      codex.pause();
      computer.stop();
      egress.pauseComputer();
    },
    renew: (owner, demand) => computer.rawCall("POST", "/lifecycle/lease", { owner, demand }),
    busy: () =>
      sessions.size > 0 || codex.status.login !== null || computer.heldScreens().length > 0,
    warn: (message, error) => log.warn(message, { error: errorMessage(error) }),
    changed: (status) => {
      log.info("computer lifecycle", {
        phase: status.phase,
        demand: status.demand,
        error: status.error,
      });
      void publishApp(ctx, { type: "computer" }).catch((error: unknown) =>
        log.warn("lifecycle status publish failed", { error: errorMessage(error) }),
      );
    },
  },
  env.COMPUTER_IDLE_MINUTES * 60_000,
);
codex.on("disconnected", () => lifecycle.connectionLost());
ctx.lifecycle = lifecycle;
computer.lifecycle = lifecycle;
codex.lifecycle = lifecycle;
if (lifecycle.enabled) egress.pauseComputer();

const telegram = new TelegramService(ctx, executor, approvals, uploads);

await executor.recover();
await executor.recoverSteers();

computer.on("health", () => void publishApp(ctx, { type: "computer" }));
computer.on("connected", () => {
  if (!lifecycle.enabled) {
    codex.start();
    executor.pump();
  }
});
codex.on("status", () => void publishApp(ctx, { type: "auth" }));
codex.on("status", (status) => {
  if (status.account && !lifecycle.enabled) executor.pump();
});
// Write the saved skills to the computer once Codex is reachable, so they're there after a rebuild.
let skillsSynced = false;
codex.on("status", (status) => {
  if (lifecycle.enabled || !status.connected || skillsSynced) return;
  skillsSynced = true;
  void skills.syncAll().catch((error: unknown) => {
    skillsSynced = false;
    log.warn("could not write the skills to the computer", { error: errorMessage(error) });
  });
});

if (!lifecycle.enabled) computer.start();
// Finishes takeovers a restart or a partly failed hand-back left behind.
const reconcileTakeovers = () =>
  void takeovers
    .reconcile()
    .catch((error: unknown) =>
      log.warn("takeover reconciliation deferred", { error: errorMessage(error) }),
    );
reconcileTakeovers();
setInterval(reconcileTakeovers, 30_000).unref();
await egress.start();
computer.on("lease", () => wake.evaluate());
setInterval(() => wake.evaluate(), 1_000).unref();
schedules.start();
triggers.start();
accountTriggers.start();
accountActions.start();
const sweepEmail = () =>
  void email
    .sweep()
    .catch((error: unknown) => log.warn("email sweep failed", { error: errorMessage(error) }));
await email
  .recover()
  .catch((error: unknown) => log.warn("email recovery failed", { error: errorMessage(error) }));
setInterval(sweepEmail, 30_000).unref();
const keepAccountsAlive = () =>
  void accountAccess
    .keepAlive()
    .catch((error: unknown) =>
      log.warn("account keep-alive failed", { error: errorMessage(error) }),
    );
setTimeout(keepAccountsAlive, 60_000).unref();
setInterval(keepAccountsAlive, 12 * 60 * 60_000).unref();
push.start();
fcm.start();
void telegram
  .start()
  .catch((error: unknown) => log.error("Telegram didn't start", { error: errorMessage(error) }));

// Wake up on signals from the web server.
const listener = await pool.connect();
await listener.query(`listen ${CHANNELS.worker}`);
listener.on("notification", (message) => {
  switch (message.payload) {
    case "runs":
      executor.pump();
      return;
    case "schedules":
      schedules.kick();
      return;
    case "triggers":
      triggers.kick();
      accountTriggers.kick();
      return;
    case "accounts":
      accountActions.kick();
      return;
    case "cancel":
      void executor
        .processCancellations()
        .catch((error: unknown) => log.error("cancel failed", { error: errorMessage(error) }));
      return;
  }
});
// Catch anything queued while no one was listening.
setInterval(() => {
  executor.pump();
  void executor.processCancellations();
}, 15_000).unref();
// Messages saved but never dispatched, like when the worker was down or crashed in between.
const reconcileDispatches = () =>
  void executor
    .reconcileDispatches()
    .catch((error: unknown) =>
      log.error("reconciling dispatches failed", { error: errorMessage(error) }),
    );
reconcileDispatches();
setInterval(reconcileDispatches, 30_000).unref();
// Attachments that never finished uploading, or that nothing ended up using.
setInterval(
  () =>
    void uploads
      .cleanup()
      .catch((error: unknown) =>
        log.warn("cleaning up uploads failed", { error: errorMessage(error) }),
      ),
  10 * 60_000,
).unref();

const server = createHttpServer({
  ctx,
  bots: botService,
  executor,
  approvals,
  takeovers,
  screenOperations,
  schedules,
  skills,
  memory,
  triggers,
  accountTriggers,
  tasks,
  push,
  fcm,
  swarms,
  connections,
  email,
  telegram,
  egress,
  wake,
  uploads,
  pages,
});
server.listen(env.WORKER_PORT, () => log.info(`worker listening on :${env.WORKER_PORT}`));

async function shutdown(signal: string) {
  log.info(`received ${signal}, shutting down`);
  server.close();
  lifecycle.stop();
  await memory.stop();
  schedules.stop();
  triggers.stop();
  accountTriggers.stop();
  accountActions.stop();
  await accountActions.idle();
  await integrations.stop();
  push.stop();
  fcm.stop();
  telegram.stop();
  egress.stop();
  codex.stop();
  computer.stop();
  listener.release();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
