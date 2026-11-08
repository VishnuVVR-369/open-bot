import { EventEmitter } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import { createWorkerClient, type WorkerClient } from "@open-bot/api/worker";
import { approvals, bots, chats, runs, settings, tasks } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { ORPCError } from "@orpc/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { createHttpServer, type HttpDeps } from "../http";
import { ApprovalService } from "../services/approvals";
import { BotService } from "../services/bots";
import { CodexAccountService } from "../services/codex-account";
import { FileService } from "../services/files";
import { PushService } from "../services/push";
import { SessionRegistry } from "../services/registry";
import { RetryService } from "../services/retries";
import { ScheduleService } from "../services/schedules";
import { SkillService } from "../services/skills";
import { TaskService } from "../services/tasks";
import { TriggerService } from "../services/triggers";

const url = testDatabaseServer();
const SECRET = "router-test-secret";
const ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";

/** The status and message a call failed with. */
async function failure(call: Promise<unknown>) {
  const error = await call.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!(error instanceof ORPCError)) throw new Error(`Expected an ORPCError, got ${error}`);
  return { status: error.status, message: error.message };
}

/**
 * Every domain of the worker's internal API, called the way the web app calls it (the typed
 * client over HTTP) against the real router and services, on a disposable database. Services that
 * need the computer or an outside service are stand-ins that record what they were asked.
 */
describe.skipIf(!url)("worker internal API, end to end", () => {
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
  const teammates = new BotService(ctx, schedules, skills, sync);
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
    executor: {
      dispatchMessage: vi.fn(async () => {}),
      processCancellations: vi.fn(async () => {}),
      syncWorkspace: vi.fn(async () => {}),
    },
    retries: new RetryService(ctx),
    approvals: new ApprovalService(ctx, new SessionRegistry()),
    takeovers: { dismiss: vi.fn(async () => {}) },
    screenOperations: {
      cancel: vi.fn(async () => operation),
      context: vi.fn(async () => ({ screenId: ID, site: "example.com" })),
    },
    files: new FileService(ctx),
    pages: {
      checkAndPublish: vi.fn(async () => ({
        page: { id: ID },
        version: { id: ID, number: 1 },
        check: { issues: [{ message: "No <title>." }] },
      })),
    },
    uploads: { status: vi.fn(async () => null) },
    schedules,
    push: new PushService(ctx),
    fcm: { register: vi.fn(async () => {}) },
    tasks: new TaskService(ctx),
    email: { inbound: vi.fn(async () => ({ botId: null })) },
    connections: {
      test: vi.fn(async () => ({ ok: true, status: "ready", tools: [], error: null })),
    },
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
    egress: { status: OFFLINE_EGRESS_STATUS, setMode: vi.fn(async () => {}) },
    wake: {},
  } as unknown as HttpDeps;

  let server: http.Server;
  let worker: WorkerClient;

  beforeAll(async () => {
    await database.create();
    await db.insert(settings).values({ id: 1, timezone: "Asia/Kolkata" }).onConflictDoNothing();
    vi.spyOn(schedules, "kick").mockImplementation(() => {});
    vi.spyOn(triggers, "kick").mockImplementation(() => {});
    server = createHttpServer(services);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    worker = createWorkerClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secret: SECRET,
    });
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
    return { ...created, id: created.botId };
  }

  /** A teammate with a failed run in their chat. */
  async function teammateWithRun() {
    const created = await newTeammate("Ada", "researcher");
    const [run] = await db
      .insert(runs)
      .values({
        botId: created.id,
        chatId: created.chatId,
        trigger: "user",
        prompt: "Summarize the news",
        status: "failed",
      })
      .returning();
    return { created, run: run! };
  }

  it("status: reports the computer, Codex and egress without waking anything", async () => {
    expect(await worker.status.get()).toEqual({
      computer: { online: true, health: null, lifecycle: null },
      codex: codexStatus,
      egress: OFFLINE_EGRESS_STATUS,
    });
  });

  it("teammates: creates, edits, and refuses an edit made from a stale copy", async () => {
    const created = await worker.teammates.create({ name: "Grace", role: "engineer" });
    expect(created).toMatchObject({ name: "Grace", chatPath: `/chats/${created.chatId}` });
    const teammateId = created.botId;
    const updated = await worker.teammates.update({
      teammateId,
      changes: { role: "staff engineer" },
      expected_revision: created.revision,
    });
    expect(updated.revision).not.toBe(created.revision);
    expect(
      await failure(
        worker.teammates.update({
          teammateId,
          changes: { role: "manager" },
          expected_revision: created.revision,
        }),
      ),
    ).toMatchObject({ status: 409 });
    await worker.teammates.sync({ teammateId });
    expect(services.executor.syncWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: teammateId }),
    );
    expect(await failure(worker.teammates.sync({ teammateId: ID }))).toEqual({
      status: 404,
      message: "No such teammate.",
    });
  });

  it("messages and runs: dispatches, retries once however often asked, and cancels", async () => {
    await worker.messages.dispatch({ messageId: ID });
    expect(services.executor.dispatchMessage).toHaveBeenLastCalledWith(ID);
    const { run } = await teammateWithRun();
    const [first, again] = await Promise.all([
      worker.runs.retry({ runId: run.id }),
      worker.runs.retry({ runId: run.id }),
    ]);
    expect(first.runId).not.toBe(run.id);
    expect(again).toEqual(first);
    expect(await failure(worker.runs.retry({ runId: first.runId }))).toEqual({
      status: 409,
      message: "That run is still going.",
    });
    await worker.runs.processCancellations();
    expect(services.executor.processCancellations).toHaveBeenCalled();
  });

  it("approvals: decides once, and says how one decided elsewhere ended", async () => {
    const { created, run } = await teammateWithRun();
    const [approval] = await db
      .insert(approvals)
      .values({
        runId: run.id,
        botId: created.id,
        chatId: created.chatId,
        kind: "command",
        title: "Run ls",
        itemId: "item-1",
      })
      .returning();
    expect(
      await worker.approvals.decide({ approvalId: approval!.id, decision: "approved" }),
    ).toEqual({ decided: true, status: "approved" });
    expect(await worker.approvals.decide({ approvalId: approval!.id, decision: "denied" })).toEqual(
      { decided: false, status: "approved" },
    );
    expect(await failure(worker.approvals.decide({ approvalId: ID, decision: "denied" }))).toEqual({
      status: 404,
      message: "That approval is gone.",
    });
    await worker.approvals.removeRule({ ruleId: ID });
  });

  it("screens, takeovers and screen operations: reach the computer for a real teammate", async () => {
    const created = await newTeammate("Linus", "operator");
    await worker.screens.wake({ screenId: created.id });
    expect(ctx.computer.startScreen).toHaveBeenLastCalledWith(created.id);
    expect(await failure(worker.screens.wake({ screenId: ID }))).toMatchObject({ status: 404 });
    expect(await worker.takeovers.codeContext({ takeoverId: ID })).toEqual({
      screenId: ID,
      site: "example.com",
    });
    await worker.takeovers.dismiss({ takeoverId: ID });
    expect(await worker.screenOperations.cancel({ operationId: ID })).toEqual(operation);
  });

  it("files: lists, reads, never overwrites, and keeps what the system needs", async () => {
    const listing = await worker.files.list({ path: "/home/bot/shared" });
    expect(listing.entries).toEqual([
      {
        name: "notes.md",
        path: "/home/bot/shared/notes.md",
        isDirectory: false,
        modifiedAt: "2026-11-08T00:00:00.000Z",
      },
    ]);
    expect(await worker.files.read({ path: "/home/bot/shared/notes.md" })).toEqual({
      path: "/home/bot/shared/notes.md",
      dataBase64: "aGk=",
    });
    expect(
      await worker.files.put({ dir: "/home/bot/shared", name: "notes.md", dataBase64: "eW8=" }),
    ).toEqual({ path: "/home/bot/shared/notes (2).md" });
    await worker.files.write({ path: "/home/bot/shared/new.txt", dataBase64: "" });
    await worker.files.remove({ path: "/home/bot/shared/new.txt" });
    expect(files.has("/home/bot/shared/new.txt")).toBe(false);
    expect(await failure(worker.files.read({ path: "/etc/passwd" }))).toEqual({
      status: 400,
      message: "Path must be inside /home/bot",
    });
    expect(await failure(worker.files.list({ path: "/home/bot/.codex" }))).toMatchObject({
      status: 403,
    });
    const created = await newTeammate("Hopper", "admiral");
    const [row] = await db.select().from(bots).where(eq(bots.id, created.id));
    expect(
      await failure(worker.files.remove({ path: `/home/bot/bots/${row!.slug}` })),
    ).toMatchObject({ status: 403 });
  });

  it("pages and uploads: publish with warnings, and a missing upload is a 404", async () => {
    expect(
      await worker.pages.publish({
        botId: ID,
        path: "/home/bot/shared/report.html",
        title: "Report",
      }),
    ).toEqual({ pageId: ID, versionId: ID, version: 1, warnings: ["No <title>."] });
    expect(await failure(worker.uploads.status({ uploadId: ID }))).toEqual({
      status: 404,
      message: "That upload isn't here.",
    });
  });

  it("schedules: saves a routine and says why a reminder can't be saved", async () => {
    const created = await newTeammate("Mary", "planner");
    const schedule = {
      botId: created.id,
      title: "Morning brief",
      prompt: "Brief me",
      cron: "0 9 * * *",
      at: null,
      timezone: null,
    };
    const { id } = await worker.schedules.create(schedule);
    await worker.schedules.setEnabled({ scheduleId: id, enabled: false });
    expect(
      await failure(
        worker.schedules.update({ ...schedule, scheduleId: id, cron: null, at: "2001-01-01" }),
      ),
    ).toEqual({ status: 400, message: "That time is in the past." });
  });

  it("push: a browser outside https can't subscribe, and a phone can register", async () => {
    expect(
      await failure(
        worker.push.subscribe({
          subscription: { endpoint: "http://push.test/1", keys: { p256dh: "k", auth: "a" } },
        }),
      ),
    ).toEqual({ status: 400, message: "Push services use https." });
    await worker.push.registerNative({ token: "fcm-token", platform: "android" });
    expect(services.fcm.register).toHaveBeenLastCalledWith({
      token: "fcm-token",
      platform: "android",
      device: "",
    });
    expect((await worker.push.status()).devices).toEqual([]);
  });

  it("tasks: creates, moves and deletes one", async () => {
    const { id } = await worker.tasks.create({ title: "Write the launch post" });
    await worker.tasks.update({ taskId: id, status: "doing", notes: "Draft first" });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(task).toMatchObject({ status: "doing", notes: "Draft first" });
    await worker.tasks.remove({ taskId: id });
    expect(await db.select().from(tasks).where(eq(tasks.id, id))).toEqual([]);
  });

  it("triggers and hooks: a webhook gets a URL, and an unknown one is a 404", async () => {
    const created = await newTeammate("Ida", "watcher");
    const hook = await worker.triggers.create({
      botId: created.id,
      kind: "webhook",
      title: "Deploys",
      prompt: "Tell me about deploys",
    });
    expect(hook.hookPath).toMatch(/^\/api\/hooks\/[\w-]+$/);
    const { token } = await worker.triggers.rotateToken({ triggerId: hook.id });
    expect(hook.hookPath).not.toContain(token);
    await worker.triggers.setEnabled({ triggerId: hook.id, enabled: false });
    expect(
      await failure(
        worker.hooks.fire({ token, method: "POST", contentType: "", body: "", query: "" }),
      ),
    ).toEqual({ status: 409, message: "This webhook is paused" });
    expect(
      await failure(
        worker.hooks.fire({ token: "nope", method: "POST", contentType: "", body: "", query: "" }),
      ),
    ).toEqual({ status: 404, message: "Unknown webhook" });
  });

  it("skills: saves one, and says why a name can't be used", async () => {
    const { id } = await worker.skills.save({
      name: "weekly-report",
      description: "Write the weekly report",
      instructions: "Summarize the week",
      botId: null,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await failure(
        worker.skills.save({ name: "page", description: "x", instructions: "y", botId: null }),
      ),
    ).toEqual({ status: 400, message: "That name belongs to a built-in skill. Pick another." });
    await worker.skills.remove({ skillId: id });
  });

  it("codex: saves where the login comes from, and signs in again", async () => {
    expect(await worker.codex.setAuthSource({ source: "device" })).toEqual(codexStatus);
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    expect(row!.chatgptAuthSource).toBe("device");
    expect(ctx.codex.logout).toHaveBeenCalledOnce();
  });

  it("email, connections, swarms, telegram and egress: reach their services", async () => {
    expect(
      await worker.email.inbound({ params: { token: "inbound-token" }, body: { Subject: "Hi" } }),
    ).toEqual({ ok: true, botId: null });
    expect(services.email.inbound).toHaveBeenLastCalledWith("inbound-token", { Subject: "Hi" });
    expect(await worker.connections.test({ connectionId: ID })).toMatchObject({ ok: true });
    await worker.swarms.stop({ swarmId: ID });
    expect(services.swarms.stop).toHaveBeenLastCalledWith(ID);
    expect(await worker.telegram.status()).toMatchObject({ connected: false });
    await worker.egress.setMode({ mode: "prefer" });
    expect(services.egress.setMode).toHaveBeenLastCalledWith("prefer");
    expect(await failure(worker.egress.setMode({ mode: "sometimes" as "off" }))).toMatchObject({
      status: 400,
    });
  });

  it("refuses a caller without the worker's secret", async () => {
    const stranger = createWorkerClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secret: "wrong",
    });
    expect(await failure(stranger.status.get())).toEqual({ status: 401, message: "unauthorized" });
    expect(await db.select().from(chats).where(eq(chats.id, ID))).toEqual([]);
  });
});
