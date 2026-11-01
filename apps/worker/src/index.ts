import { CHANNELS, computers, createDb, createPool, settings } from "@open-bot/db";
import { CodexManager } from "./codex";
import { ComputerClient } from "./computer";
import { publishApp, type Context } from "./context";
import { EgressRelay } from "./egress-relay";
import { env } from "./env";
import { createHttpServer } from "./http";
import { PushService } from "./services/push";
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
import { MemoryCoordinator } from "./services/memory";
import { SkillService } from "./services/skills";
import { TakeoverService } from "./services/takeovers";
import { TelegramService } from "./services/telegram";
import { TriggerService } from "./services/triggers";
import { ToolHandlers } from "./tools/handlers";
import { BotService } from "./services/bots";
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
const schedules = new ScheduleService(ctx);
const skills = new SkillService(ctx);
const triggers = new TriggerService(ctx);
const tasks = new TaskService(ctx);
const push = new PushService(ctx);
const vault = new VaultService(ctx, approvals);
const swarms = new SwarmService(ctx, sessions);
const email = new EmailService(ctx, approvals, sessions);
const botService = new BotService(ctx, schedules, skills, async (bot) => {
  await memory.store.importLegacy();
  await executor.syncWorkspace(bot);
});
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
);
const model = new ModelAccess(ctx);
const connections = new ConnectionService(ctx);
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
);
const egress = new EgressRelay(ctx);
const telegram = new TelegramService(ctx, executor, approvals);

await executor.recover();

computer.on("health", () => void publishApp(ctx, { type: "computer" }));
computer.on("connected", () => {
  codex.start();
  executor.pump();
});
codex.on("status", () => void publishApp(ctx, { type: "auth" }));
codex.on("status", (status) => {
  if (status.account) executor.pump();
});
// Write the saved skills to the computer once Codex is reachable, so they're there after a rebuild.
let skillsSynced = false;
codex.on("status", (status) => {
  if (!status.connected || skillsSynced) return;
  skillsSynced = true;
  void skills.syncAll().catch((error: unknown) => {
    skillsSynced = false;
    log.warn("could not write the skills to the computer", { error: errorMessage(error) });
  });
});

computer.start();
await egress.start();
schedules.start();
triggers.start();
push.start();
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

const server = createHttpServer({
  ctx,
  bots: botService,
  executor,
  approvals,
  takeovers,
  schedules,
  skills,
  memory,
  triggers,
  tasks,
  push,
  swarms,
  connections,
  email,
  telegram,
  egress,
});
server.listen(env.WORKER_PORT, () => log.info(`worker listening on :${env.WORKER_PORT}`));

async function shutdown(signal: string) {
  log.info(`received ${signal}, shutting down`);
  server.close();
  await memory.stop();
  schedules.stop();
  triggers.stop();
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
