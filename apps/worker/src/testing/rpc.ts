import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import { createWorkerClient } from "@open-bot/api/worker";
import { runs, settings } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { ORPCError } from "@orpc/client";
import { afterAll, beforeAll, expect, vi } from "vitest";
import type { Context } from "../context";
import { createHttpServer, type HttpDeps } from "../http";
import { ApprovalService } from "../features/approvals";
import { APPROVAL_OUTCOMES } from "../approval-outcomes";
import { TeammateService } from "../features/teammates";
import { ChatService } from "../features/chat";
import { RunRequests } from "../runs/requests";
import { CodexAccountService } from "../features/codex-account";
import { ConnectionService } from "../features/connections";
import { EgressDevices } from "../egress/devices";
import { PageService } from "../features/pages";
import { VaultService } from "../features/vault";
import { EmailService } from "../features/email";
import { SettingsService } from "../features/settings";
import { FileService } from "../features/files";
import { PushService } from "../features/notifications";
import { SessionRegistry } from "../runs/registry";
import { RetryService } from "../runs/retries";
import { ScheduleService, TriggerService } from "../features/automations";
import { SkillService } from "../features/skills";
import { TaskService } from "../features/tasks";
import { MemoryService } from "@open-bot/memory";

const url = testDatabaseServer();
export const SECRET = "router-test-secret";
export const ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";

/** The status and message a call failed with. */
export async function failure(call: Promise<unknown>) {
  const error = await call.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!(error instanceof ORPCError)) throw new Error(`Expected an ORPCError, got ${error}`);
  return { status: error.status, message: error.message };
}
export const rpcEnabled = Boolean(url);

/** One disposable database and HTTP worker per feature suite. */
export function rpcHarness() {
  const database = testDatabase(url);
  const { pool, db } = database;
  const files = new Map<string, string>([["/home/bot/shared/notes.md", "aGk="]]);
  const codexRequest = vi.fn(
    async (method: string, params: { path: string; dataBase64?: string }) => {
      if (method === "fs/readDirectory")
        return {
          entries: [...files.keys()]
            .filter((path) => path.startsWith(`${params.path}/`))
            .map((path) => ({ fileName: path.slice(params.path.length + 1), isDirectory: false })),
        };
      if (method === "fs/getMetadata") return { modifiedAtMs: Date.UTC(2026, 10, 8) };
      if (method === "fs/readFile") return { dataBase64: files.get(params.path) };
      if (method === "fs/writeFile") files.set(params.path, params.dataBase64!);
      if (method === "fs/remove") files.delete(params.path);
      return {};
    },
  );
  const codexStatus = {
    connected: true,
    authSource: "host" as const,
    account: null,
    login: null,
    error: null,
  };
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    env: {
      APP_URL: "https://openbot.test",
      WORKER_SECRET: SECRET,
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    computer: {
      online: true,
      health: null,
      startScreen: vi.fn(async () => ({})),
      forgetScreen: vi.fn(async () => {}),
    },
    codex: {
      status: codexStatus,
      ready: async () => ({ request: codexRequest }),
      logout: vi.fn(async () => {}),
      reauthenticate: vi.fn(async () => codexStatus),
    },
  } as unknown as Context;
  const schedules = new ScheduleService(ctx);
  const skills = new SkillService(ctx);
  const triggers = new TriggerService(ctx);
  const sync = vi.fn(async () => {});
  const memory = new MemoryService(db);
  const teammates = new TeammateService(ctx, schedules, skills, memory, sync);
  const executor = {
    dispatchMessage: vi.fn(async (_messageId: string) => {}),
    processCancellations: vi.fn(async () => {}),
    syncWorkspace: vi.fn(async () => {}),
  };
  const chatService = new ChatService(ctx, (messageId) => executor.dispatchMessage(messageId));
  const approvalService = new ApprovalService(ctx, new SessionRegistry(), APPROVAL_OUTCOMES);
  const email = new EmailService(ctx, approvalService, new SessionRegistry(), {
    save: vi.fn(async () => {
      throw new Error("No attachments here.");
    }),
  });
  vi.spyOn(email, "inbound").mockImplementation(async () => ({ teammateId: null }));
  const accountStore = { revoke: vi.fn(async () => ({ warning: null })) };
  const accountActionLoop = { kick: vi.fn() };
  const connectionService = new ConnectionService(ctx, undefined, accountStore, accountActionLoop);
  vi.spyOn(connectionService, "test").mockImplementation(async () => ({
    ok: true,
    status: "ready",
    tools: [],
    error: null,
  }));
  const pageService = new PageService(ctx);
  vi.spyOn(pageService, "checkAndPublish").mockImplementation(
    async () =>
      ({
        page: { id: ID },
        version: { id: ID, number: 1 },
        check: { issues: [{ message: "No <title>." }] },
      }) as unknown as Awaited<ReturnType<PageService["checkAndPublish"]>>,
  );
  const relay = { revoke: vi.fn(async () => {}), reloadPhones: vi.fn(async () => {}) };
  const operation = {
    id: ID,
    takeoverId: ID,
    screenId: ID,
    status: "cancelled" as const,
    reason: null,
  };
  const services = {
    ctx,
    teammates,
    chats: chatService,
    runRequests: new RunRequests(ctx, chatService, memory, () => executor.processCancellations()),
    executor,
    retries: new RetryService(ctx),
    approvals: approvalService,
    takeovers: { dismiss: vi.fn(async () => {}) },
    screenOperations: {
      cancel: vi.fn(async () => operation),
      context: vi.fn(async () => ({ screenId: ID, site: "example.com" })),
    },
    files: new FileService(ctx),
    pages: pageService,
    vault: new VaultService(ctx, approvalService),
    uploads: { status: vi.fn(async () => null) },
    schedules,
    push: new PushService(ctx),
    fcm: { register: vi.fn(async () => {}) },
    tasks: new TaskService(ctx),
    email,
    connections: connectionService,
    swarms: { stop: vi.fn(async () => {}) },
    triggers,
    accountTriggers: {},
    telegram: {
      status: vi.fn(async () => ({
        connected: false,
        botUsername: null,
        tokenHint: null,
        linked: false,
        linkedName: null,
        problem: null,
      })),
    },
    skills,
    codexAccount: new CodexAccountService(ctx),
    settings: new SettingsService(ctx),
    egress: { status: OFFLINE_EGRESS_STATUS, setMode: vi.fn(async () => {}) },
    egressDevices: new EgressDevices(ctx, relay),
    wake: {},
  } as unknown as HttpDeps;

  const server = createHttpServer(services);
  const worker = createWorkerClient({
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secret: SECRET,
  });

  beforeAll(async () => {
    await database.create();
    await db.insert(settings).values({ id: 1, timezone: "Asia/Kolkata" }).onConflictDoNothing();
    vi.spyOn(schedules, "kick").mockImplementation(() => {});
    vi.spyOn(triggers, "kick").mockImplementation(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    schedules.stop();
    triggers.stop();
    await database.drop();
  });

  /** A new teammate, with `id` for its id. */
  async function newTeammate(name: string, role: string) {
    const created = await worker.teammates.create({ name, role });
    return { ...created, id: created.teammateId };
  }

  /**
   * Start `writes` while another transaction holds `lock`, wait until each waits on a lock, then
   * let go: none could see another's change before making its own.
   */
  async function racedWhileLocked<T>(
    lock: string,
    writes: () => Promise<T>[],
    params: unknown[] = [],
  ): Promise<T[]> {
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(lock, params);
      const running = writes();
      await vi.waitFor(async () => {
        const { rows } = await pool.query<{ waiting: number }>(
          "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        expect(rows[0]!.waiting).toBe(running.length);
      });
      await holder.query("commit");
      return await Promise.all(running);
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }

  /** A teammate with a failed run in their chat. */
  async function teammateWithRun() {
    const created = await newTeammate("Ada", "researcher");
    const [run] = await db
      .insert(runs)
      .values({
        teammateId: created.id,
        chatId: created.chatId,
        trigger: "user",
        prompt: "Summarize the news",
        status: "failed",
      })
      .returning();
    return { created, run: run! };
  }
  return {
    pool,
    db,
    files,
    codexRequest,
    codexStatus,
    ctx,
    schedules,
    skills,
    triggers,
    sync,
    memory,
    teammates,
    executor,
    chatService,
    approvalService,
    email,
    accountStore,
    accountActionLoop,
    connectionService,
    pageService,
    relay,
    operation,
    services,
    server,
    worker,
    newTeammate,
    racedWhileLocked,
    teammateWithRun,
  };
}
