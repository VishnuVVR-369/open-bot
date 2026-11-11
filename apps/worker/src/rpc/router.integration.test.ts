import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import { createWorkerClient, type WorkerClient } from "@open-bot/api/worker";
import {
  approvalRules,
  approvals,
  bots as teammateRows, // vocabulary: allow
  chatMembers,
  chats,
  instructionProposals,
  lessons,
  memoryItems,
  messages,
  runs,
  schedules as scheduleRows,
  settings,
  tasks,
  triggers as triggerRows,
} from "@open-bot/db";
import { BUNDLE_FORMAT, BUNDLE_VERSION, type TeammateBundle } from "@open-bot/domain";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { ORPCError } from "@orpc/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { createHttpServer, type HttpDeps } from "../http";
import { ApprovalService } from "../services/approvals";
import { BotService } from "../services/bots";
import { ChatService, REUSED_ID } from "../services/chats";
import { RunRequests } from "../runs/requests";
import { CodexAccountService } from "../services/codex-account";
import { FileService } from "../services/files";
import { PushService } from "../services/push";
import { SessionRegistry } from "../services/registry";
import { RetryService } from "../services/retries";
import { ScheduleService } from "../services/schedules";
import { SkillService } from "../services/skills";
import { TaskService } from "../services/tasks";
import { TriggerService } from "../services/triggers";
import { MemoryService } from "@open-bot/memory";

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
  const memory = new MemoryService(pool);
  const teammates = new BotService(ctx, schedules, skills, memory, sync);
  const executor = {
    dispatchMessage: vi.fn(async (_messageId: string) => {}),
    processCancellations: vi.fn(async () => {}),
    syncWorkspace: vi.fn(async () => {}),
  };
  const chatService = new ChatService(ctx, (messageId) => executor.dispatchMessage(messageId));
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
    const [row] = await db.select().from(teammateRows).where(eq(teammateRows.id, created.id));
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

  describe("chat and run writes", () => {
    it("starts direct and group chats, and renames, reads and archives them", async () => {
      const ada = await newTeammate("Ada", "researcher");
      const bea = await newTeammate("Bea", "writer");
      const { chatId } = await worker.chats.newDirect({ teammateId: ada.id });
      const [direct] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(direct).toMatchObject({ kind: "direct", title: "Ada", titled: false });
      expect(await failure(worker.chats.newDirect({ teammateId: ID }))).toEqual({
        status: 404,
        message: "That teammate no longer exists.",
      });

      const group = await worker.chats.createGroup({
        title: "Launch",
        teammateIds: [ada.id, bea.id, ada.id],
      });
      const members = await db
        .select({ teammateId: chatMembers.botId }) // vocabulary: allow
        .from(chatMembers)
        .where(eq(chatMembers.chatId, group.chatId));
      expect(members.map((m) => m.teammateId).sort()).toEqual([ada.id, bea.id].sort());
      expect(
        await failure(worker.chats.createGroup({ title: "Solo", teammateIds: [ada.id, ada.id] })),
      ).toEqual({ status: 400, message: "Pick at least two teammates." });
      expect(
        await failure(worker.chats.createGroup({ title: "Ghost", teammateIds: [ada.id, ID] })),
      ).toEqual({ status: 404, message: "One of those teammates no longer exists." });

      await worker.chats.rename({ chatId, title: "Research" });
      await worker.chats.markRead({ chatId });
      await worker.chats.archive({ chatId });
      const [changed] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(changed).toMatchObject({ title: "Research", titled: true });
      expect(changed!.readAt.getTime()).toBeGreaterThan(direct!.readAt.getTime());
      expect(changed!.archivedAt).not.toBeNull();
      for (const call of [
        () => worker.chats.rename({ chatId: ID, title: "Gone" }),
        () => worker.chats.markRead({ chatId: ID }),
        () => worker.chats.archive({ chatId: ID }),
      ])
        expect(await failure(call())).toEqual({
          status: 404,
          message: "That chat no longer exists.",
        });
    });

    it("saves a sent message once, delivers it, and refuses a reused id or a file not uploaded", async () => {
      const { chatId } = await newTeammate("Cy", "analyst");
      const send = { clientId: randomUUID(), chatId, text: " Hi ", attachments: [], mentions: [] };
      const sent = await worker.chats.send(send);
      expect(sent).toMatchObject({ role: "user", text: "Hi", redoOfRunId: null });
      expect(executor.dispatchMessage).toHaveBeenLastCalledWith(sent.id);
      // A retry gets the same message, and asks for delivery again.
      executor.dispatchMessage.mockClear();
      expect((await worker.chats.send(send)).id).toBe(sent.id);
      expect(executor.dispatchMessage).toHaveBeenCalledWith(sent.id);
      expect(await db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(1);
      expect(await failure(worker.chats.send({ ...send, text: "Other" }))).toEqual({
        status: 409,
        message: REUSED_ID,
      });
      // Saving is what counts: a delivery that fails is left to the reconciler.
      executor.dispatchMessage.mockRejectedValueOnce(new Error("busy"));
      const later = await worker.chats.send({ ...send, clientId: randomUUID(), text: "Later" });
      expect(later.text).toBe("Later");
      expect(ctx.log.warn).toHaveBeenCalledWith(
        "dispatch deferred to the reconciler",
        expect.objectContaining({ messageId: later.id }),
      );

      const fresh = { ...send, clientId: randomUUID() };
      expect(await failure(worker.chats.send({ ...fresh, text: " " }))).toEqual({
        status: 400,
        message: "Write a message first.",
      });
      expect(await failure(worker.chats.send({ ...fresh, chatId: ID }))).toEqual({
        status: 404,
        message: "That chat no longer exists.",
      });
      const attachment = {
        path: "/home/bot/uploads/never/notes.txt",
        name: "notes.txt",
        mime: "text/plain",
        size: 3,
      };
      expect(await failure(worker.chats.send({ ...fresh, attachments: [attachment] }))).toEqual({
        status: 400,
        message: "notes.txt didn't finish uploading. Attach it again.",
      });
      expect(await db.select().from(messages).where(eq(messages.clientId, fresh.clientId))).toEqual(
        [],
      );
    });

    it("stops and rates a run, and takes feedback once per redo id", async () => {
      const { created, run } = await teammateWithRun();
      await worker.runs.stop({ runId: run.id });
      const stopped = async () => (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
      expect((await stopped()).cancelRequestedAt).not.toBeNull();
      expect(executor.processCancellations).toHaveBeenCalled();
      await worker.runs.rate({ runId: run.id, rating: "up" });
      expect((await stopped()).rating).toBe("up");
      for (const call of [
        () => worker.runs.stop({ runId: ID }),
        () => worker.runs.rate({ runId: ID, rating: null }),
        () => worker.runs.feedback({ runId: ID, text: "No", remember: false, redo: null }),
      ])
        expect(await failure(call())).toEqual({ status: 404, message: "That reply is gone." });

      await worker.runs.feedback({
        runId: run.id,
        text: "Cite sources.",
        remember: true,
        redo: null,
      });
      expect((await stopped()).rating).toBe("down");
      const kept = await db
        .select({ content: memoryItems.content })
        .from(memoryItems)
        .where(and(eq(memoryItems.botId, created.id), eq(memoryItems.kind, "lesson"))); // vocabulary: allow
      expect(kept).toEqual([{ content: "Cite sources." }]);
      // A lesson memory refuses is the owner's to fix, not the worker's failure.
      expect(
        await failure(
          worker.runs.feedback({ runId: run.id, text: "No", remember: true, redo: null }),
        ),
      ).toMatchObject({ status: 400 });

      await worker.runs.rate({ runId: run.id, rating: null });
      const redo = { clientId: randomUUID() };
      const feedback = { runId: run.id, text: "Shorter.", remember: false, redo };
      await worker.runs.feedback(feedback);
      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.clientId, redo.clientId));
      expect(message).toMatchObject({
        chatId: created.chatId,
        text: "Shorter.",
        redoOfRunId: run.id,
        feedbackRequest: { text: "Shorter.", remember: false },
      });
      expect((await stopped()).rating).toBe("down");
      expect(executor.dispatchMessage).toHaveBeenLastCalledWith(message!.id);
      // The same feedback again delivers the saved message; other feedback with its id is refused.
      await worker.runs.feedback(feedback);
      expect(await db.select().from(messages).where(eq(messages.redoOfRunId, run.id))).toHaveLength(
        1,
      );
      expect(await failure(worker.runs.feedback({ ...feedback, text: "Longer." }))).toEqual({
        status: 409,
        message: REUSED_ID,
      });
    });
  });

  describe("teammate writes", () => {
    /** A row's teammate, under the column's legacy name. */
    const owned = (teammateId: string) => ({ botId: teammateId }); // vocabulary: allow
    /** A teammate file with this name, and these parts. */
    const file = (name: string, parts: Partial<TeammateBundle> = {}): TeammateBundle => ({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      teammate: { name, role: "Helper", instructions: "", emoji: "", autonomy: "risky" },
      skills: [],
      routines: [],
      watches: [],
      allowed: [],
      lessons: [],
      ...parts,
    });
    const imported = (name: string, parts?: Partial<TeammateBundle>) =>
      worker.teammates.import({ bundle: file(name, parts) });

    type Row = {
      id: string;
      name: string;
      slug: string;
      archived: boolean;
      lead: boolean;
      updatedAt: string;
    };
    async function team(): Promise<Row[]> {
      const { rows } = await db.execute<Row>(
        sql`select id, name, slug, archived_at is not null as archived, is_primary as lead, updated_at::text as "updatedAt" from bots`, // vocabulary: allow
      );
      return rows;
    }
    const row = async (id: string) => (await team()).find((entry) => entry.id === id)!;
    const leads = async () =>
      (await team()).filter((entry) => entry.lead).map((entry) => entry.name);

    it("imports a file: parts come along, routines and watches paused, lessons into memory", async () => {
      const atlas = await imported("Atlas", {
        skills: [{ name: "atlas-brief", description: "Brief me", instructions: "Write a brief." }],
        routines: [
          { title: "Weekly plan", prompt: "Plan the week", cron: "0 9 * * 1", quiet: false },
          { title: "Broken", prompt: "Never", cron: "not a cron", quiet: false },
        ],
        watches: [
          {
            title: "Pricing",
            prompt: "Tell me",
            url: "https://example.test/pricing",
            intervalMinutes: 60,
            lookFor: null,
          },
        ],
        allowed: [{ kind: "command", pattern: "  git   status " }],
        lessons: ["Keep answers short."],
      });
      expect(atlas).toMatchObject({ name: "Atlas", paused: 3 });
      expect(await row(atlas.teammateId)).toMatchObject({ slug: "atlas" });
      const routines = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, atlas.teammateId)); // vocabulary: allow
      // The cron it can't read is left out; the other starts paused in the owner's time zone.
      expect(routines.map((r) => [r.title, r.enabled, r.timezone])).toEqual([
        ["Weekly plan", false, "Asia/Kolkata"],
      ]);
      const watches = await db
        .select()
        .from(triggerRows)
        .where(eq(triggerRows.botId, atlas.teammateId)); // vocabulary: allow
      expect(watches.map((w) => [w.title, w.enabled])).toEqual([["Pricing", false]]);
      const exported = await worker.teammates.export({ teammateId: atlas.teammateId });
      expect(exported.slug).toBe("atlas");
      expect(exported.bundle).toMatchObject({
        skills: [{ name: "atlas-brief" }],
        allowed: [{ kind: "command", pattern: "git status" }],
        lessons: ["Keep answers short."],
      });
      // A lesson lives in memory, so the next memory change keeps it.
      await memory.addLessons(atlas.teammateId, ["Cite sources."]);
      const learned = await db
        .select({ text: lessons.text })
        .from(lessons)
        .where(eq(lessons.botId, atlas.teammateId)); // vocabulary: allow
      expect(learned.map((l) => l.text).sort()).toEqual(["Cite sources.", "Keep answers short."]);
    });

    it("keeps every rule and lesson a file carries whole, and exports what memory holds", async () => {
      // Cut short, this rule would allow every `git -C <dir>` command, not only `status`.
      const pattern = `git -C /home/bot/${"d".repeat(280)} status`;
      expect(pattern.length).toBeGreaterThan(300);
      const kit = await imported("Kit", {
        allowed: [{ kind: "command", pattern }],
        lessons: ["简洁"],
      });
      const rules = await db
        .select({ pattern: approvalRules.pattern })
        .from(approvalRules)
        .where(eq(approvalRules.botId, kit.teammateId)); // vocabulary: allow
      expect(rules).toEqual([{ pattern }]);
      // A lesson longer than a file allows, which memory holds, still exports.
      const long = `Explain it. ${"x".repeat(600)}`;
      await memory.addLessons(kit.teammateId, [long]);
      const exported = await worker.teammates.export({ teammateId: kit.teammateId });
      expect(exported.bundle.allowed).toEqual([{ kind: "command", pattern }]);
      expect([...exported.bundle.lessons].sort()).toEqual([long, "简洁"].sort());
    });

    it("adds nobody when a teammate's lessons can't be saved", async () => {
      vi.spyOn(memory, "addLessons").mockRejectedValueOnce(new Error("memory is down"));
      expect(await failure(imported("Ghost", { lessons: ["Be brief."] }))).toMatchObject({
        status: 500,
      });
      expect((await team()).filter((entry) => entry.name === "Ghost")).toEqual([]);
      const ghostChats = await db.select().from(chats).where(eq(chats.title, "Ghost"));
      expect(ghostChats).toEqual([]);
    });

    it("duplicates a teammate with its memory and reminders, and refuses one that's gone", async () => {
      const scout = await imported("Scout", {
        routines: [{ title: "Morning news", prompt: "News", cron: "0 8 * * *", quiet: false }],
        lessons: ["Prefer primary sources."],
      });
      await db.insert(scheduleRows).values({
        ...owned(scout.teammateId),
        title: "Call mom",
        prompt: "Remind me",
        kind: "once",
        runAt: new Date(Date.now() + 86_400_000),
        nextRunAt: new Date(Date.now() + 86_400_000),
        timezone: "Asia/Kolkata",
        createdBy: "user",
      });
      await memory.save(
        {
          ...owned(scout.teammateId),
          kind: "fact",
          content: "Prefers window seats",
          key: null,
          pinned: false,
          expiresAt: null,
        },
        { kind: "user" },
      );
      const copy = await worker.teammates.duplicate({
        teammateId: scout.teammateId,
        name: "Scout",
        copyMemory: true,
      });
      expect(copy.memoryCopied).toBe(true);
      expect(await row(copy.teammateId)).toMatchObject({
        name: "Scout",
        slug: "scout-2",
        lead: false,
      });
      const [chat] = await db.select().from(chats).where(eq(chats.id, copy.chatId));
      expect(chat).toMatchObject({ kind: "direct", ...owned(copy.teammateId) });
      const copied = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, copy.teammateId)); // vocabulary: allow
      expect(copied.map((r) => [r.title, r.enabled]).sort()).toEqual([
        ["Call mom", false],
        ["Morning news", false],
      ]);
      const memories = await memory.list({ ...owned(copy.teammateId) }, { kind: "user" });
      expect(memories.map((m) => m.content).sort()).toEqual([
        "Prefer primary sources.",
        "Prefers window seats",
      ]);
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ id: copy.teammateId }));
      // Without memory, no lessons either.
      const bare = await worker.teammates.duplicate({
        teammateId: scout.teammateId,
        name: "Bare",
        copyMemory: false,
      });
      expect(await memory.list({ ...owned(bare.teammateId) }, { kind: "user" })).toEqual([]);
      expect(
        await failure(
          worker.teammates.duplicate({ teammateId: ID, name: "Nobody", copyMemory: false }),
        ),
      ).toMatchObject({ status: 404 });
    });

    it("gives copies made at once different slugs", async () => {
      const echo = await imported("Original");
      const copies = await Promise.all(
        [1, 2, 3].map(() =>
          worker.teammates.duplicate({
            teammateId: echo.teammateId,
            name: "Echo",
            copyMemory: false,
          }),
        ),
      );
      const slugs = await Promise.all(copies.map(async (c) => (await row(c.teammateId)).slug));
      expect(slugs.sort()).toEqual(["echo", "echo-2", "echo-3"]);
    });

    it("makes one teammate the lead, refusing one that's gone, and touches only the two", async () => {
      const iris = await imported("Iris");
      const kit = await imported("Kit");
      const bystander = await imported("Bystander");
      const gone = await imported("Gone");
      await worker.teammates.archive({ teammateId: gone.teammateId });
      await worker.teammates.setLead({ teammateId: iris.teammateId });
      expect(await leads()).toEqual(["Iris"]);
      const before = (await row(bystander.teammateId)).updatedAt;
      await worker.teammates.setLead({ teammateId: kit.teammateId });
      await worker.teammates.setLead({ teammateId: iris.teammateId });
      expect(await leads()).toEqual(["Iris"]);
      // Only the rows that change, so other teammates keep their revisions.
      expect((await row(bystander.teammateId)).updatedAt).toBe(before);
      for (const teammateId of [gone.teammateId, ID])
        expect(await failure(worker.teammates.setLead({ teammateId }))).toEqual({
          status: 404,
          message: "That teammate no longer exists.",
        });
      expect(await leads()).toEqual(["Iris"]);
    });

    it("keeps exactly one lead when two are chosen at once", async () => {
      const juno = await imported("Juno");
      const max = await imported("Max");
      for (let round = 0; round < 10; round += 1) {
        await Promise.all([
          worker.teammates.setLead({ teammateId: juno.teammateId }),
          worker.teammates.setLead({ teammateId: max.teammateId }),
        ]);
        expect(await leads()).toHaveLength(1);
      }
    });

    it("archives a teammate: its chats, automations and work stop together", async () => {
      const { teammateId, chatId } = await imported("Retiring", {
        routines: [{ title: "Digest", prompt: "Sum up", cron: "0 18 * * *", quiet: false }],
      });
      await worker.teammates.setLead({ teammateId });
      const [run] = await db
        .insert(runs)
        .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "queued" })
        .returning({ id: runs.id });
      await db
        .update(scheduleRows)
        .set({ enabled: true })
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      await worker.teammates.archive({ teammateId });
      expect(await row(teammateId)).toMatchObject({ archived: true, lead: false });
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(chat!.archivedAt).not.toBeNull();
      const routines = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      expect(routines.map((r) => r.enabled)).toEqual([false]);
      const [stopped] = await db.select().from(runs).where(eq(runs.id, run!.id));
      expect(stopped!.cancelRequestedAt).not.toBeNull();
      expect(ctx.computer.forgetScreen).toHaveBeenLastCalledWith(teammateId);
    });

    it("archives a teammate while a memory write holds its runs, without deadlocking", async () => {
      const { teammateId, chatId } = await imported("Busy");
      await db
        .insert(runs)
        .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "running" });
      // A memory write's order (packages/memory, `changed()`): the teammate's runs, then its row.
      const memoryWrite = await pool.connect();
      try {
        await memoryWrite.query("begin");
        await memoryWrite.query(
          "update runs set cancel_requested_at = now() where bot_id = $1", // vocabulary: allow
          [teammateId],
        );
        const archiving = worker.teammates.archive({ teammateId });
        // Wait until archiving waits on a lock the memory write holds.
        for (;;) {
          const { rows } = await pool.query<{ waiting: number }>(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          if (rows[0]!.waiting > 0) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        await memoryWrite.query(
          "update bots set lessons_changed_at = now() where id = $1", // vocabulary: allow
          [teammateId],
        );
        await memoryWrite.query("commit");
        await archiving;
      } finally {
        memoryWrite.release();
      }
      expect(await row(teammateId)).toMatchObject({ archived: true });
    });

    it("sets a budget in dollars, refusing an auto-approve over it", async () => {
      const { teammateId } = await imported("Spender");
      const budget = (budget: number | null, autoApprove: number, id = teammateId) =>
        worker.teammates.setBudget({ teammateId: id, budget, autoApprove });
      expect(await failure(budget(50, 80))).toEqual({
        status: 400,
        message: "The amount to approve on its own can't be more than the budget.",
      });
      expect(await failure(budget(50, 0, ID))).toMatchObject({ status: 404 });
      await budget(120.5, 20);
      const [spender] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
      expect(spender).toMatchObject({ monthlyBudgetCents: 12_050, autoApproveCents: 2000 });
      await budget(null, 0);
      const [none] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
      expect(none!.monthlyBudgetCents).toBeNull();
    });

    it("applies suggested instructions once, and says when a suggestion went the other way", async () => {
      const { teammateId } = await imported("Writer");
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Answer in bullets.",
        reason: "Shorter",
        runId: (await teammateWithRun()).run.id,
      });
      const [waiting] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.status, "pending"),
            eq(instructionProposals.botId, teammateId),
          ),
        ); // vocabulary: allow
      await worker.proposals.accept({ proposalId: waiting!.id });
      const instructions = async () =>
        (await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId)))[0]!
          .instructions;
      expect(await instructions()).toBe("Answer in bullets.");
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ id: teammateId }));
      await worker.proposals.accept({ proposalId: waiting!.id });
      expect(await failure(worker.proposals.dismiss({ proposalId: waiting!.id }))).toEqual({
        status: 409,
        message: "That suggestion was already handled.",
      });
      // A newer suggestion dismisses the one waiting.
      const runId = (await teammateWithRun()).run.id;
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Use headings.",
        reason: "Clearer",
        runId,
      });
      const [older] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.status, "pending"),
            eq(instructionProposals.botId, teammateId),
          ),
        ); // vocabulary: allow
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Use tables.",
        reason: "Clearer",
        runId,
      });
      expect(await failure(worker.proposals.accept({ proposalId: older!.id }))).toEqual({
        status: 409,
        message: "A newer suggestion replaced this one.",
      });
      expect(await failure(worker.proposals.dismiss({ proposalId: ID }))).toMatchObject({
        status: 404,
      });
    });

    it("removes a schedule, and a schedule already gone is fine", async () => {
      const { teammateId } = await imported("Planner", {
        routines: [{ title: "Plan", prompt: "Plan", cron: "0 9 * * *", quiet: false }],
      });
      const [routine] = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      await worker.schedules.remove({ scheduleId: routine!.id });
      await worker.schedules.remove({ scheduleId: routine!.id });
      expect(await db.select().from(scheduleRows).where(eq(scheduleRows.id, routine!.id))).toEqual(
        [],
      );
    });

    // Last: it empties the team.
    it("lets only one of two teammates imported at once into an empty team lead", async () => {
      await db
        .update(teammateRows)
        .set({ archivedAt: new Date(), isPrimary: false }) // vocabulary: allow
        .where(isNull(teammateRows.archivedAt)); // vocabulary: allow
      expect(await leads()).toEqual([]);
      await Promise.all(["Ada", "Bea"].map((name) => imported(name)));
      expect(await leads()).toHaveLength(1);
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
