import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { chats, runs, settings } from "@open-bot/db";
import type { v2 } from "@open-bot/agent";
import type { Context } from "../context";
import type { RunSession } from "../runs/session";
import { TeammateService } from "../features/teammates";
import { ApprovalService } from "../features/approvals";
import { APPROVAL_OUTCOMES } from "../approval-outcomes";
import { SessionRegistry } from "../runs/registry";
import { ScheduleService, TriggerService } from "../features/automations";
import { SkillService } from "../features/skills";
import type { ToolRegistryServices } from "../tools/dependencies";
import { ToolHandlers } from "../tools/handlers";
import { MemoryService } from "@open-bot/memory";

const url = testDatabaseServer();
export const toolsEnabled = Boolean(url);
export const toolSuiteName = "teammate management with Postgres";

/** One disposable database and real tool dispatcher per feature suite. */
export function toolHarness() {
  const database = testDatabase(url);
  const { pool, db } = database;
  const request = vi.fn(async (method: string) =>
    method === "fs/readDirectory" ? { entries: [] } : {},
  );
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    env: { APP_URL: "https://openbot.test", WORKER_SECRET: "test-worker-secret" },
    codex: { ready: async () => ({ request }) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const schedules = new ScheduleService(ctx);
  const skills = new SkillService(ctx);
  const triggers = new TriggerService(ctx);
  const sync = vi.fn(async () => {});
  const service = new TeammateService(ctx, schedules, skills, new MemoryService(db), sync);
  const approvalService = new ApprovalService(ctx, new SessionRegistry(), APPROVAL_OUTCOMES);
  const requestAction = vi.spyOn(approvalService, "requestAction").mockResolvedValue("approved");
  // Only what the teammate tools use; the rest stay empty.
  const services = {
    ctx,
    approvals: approvalService,
    schedules,
    skills,
    triggers,
    memory: {},
    teammates: service,
  } as unknown as ToolRegistryServices;
  const handlers = new ToolHandlers(services);

  beforeAll(async () => {
    await database.create();
    await db.insert(settings).values({ id: 1, timezone: "Asia/Kolkata" }).onConflictDoNothing();
    vi.spyOn(schedules, "kick").mockImplementation(() => {});
    vi.spyOn(triggers, "kick").mockImplementation(() => {});
  });
  beforeEach(async () => {
    await pool.query("truncate bots, connections restart identity cascade");
    requestAction.mockClear().mockResolvedValue("approved");
    sync.mockClear().mockResolvedValue();
  });
  afterAll(async () => {
    schedules.stop();
    triggers.stop();
    await database.drop();
  });

  async function fixture(autonomy: "full" | "risky" | "everything" = "full") {
    const created = await service.create({ name: "Lead", role: "assistant", autonomy });
    const teammate = await service.requireTeammate(created.teammateId);
    const [chat] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    const [run] = await db
      .insert(runs)
      .values({
        teammateId: teammate.id,
        chatId: created.chatId,
        trigger: "user",
        prompt: "Create and configure my teammates",
        status: "running",
      })
      .returning();
    const session = {
      teammate,
      chat,
      run,
      isHelper: false,
      now: () => new Date().toISOString(),
      putItem: vi.fn(),
      whileWaiting: async (_kind: string, work: () => Promise<unknown>) => work(),
    } as unknown as RunSession;
    return { session, created };
  }

  async function call(session: RunSession, tool: string, args: Record<string, unknown> = {}) {
    const response = await handlers.handle(session, {
      tool,
      arguments: args,
      callId: crypto.randomUUID(),
      threadId: "thread",
      turnId: "turn",
      namespace: null,
    } as v2.DynamicToolCallParams);
    const value = response.contentItems[0];
    if (value?.type !== "inputText") throw new Error("Expected a text tool response");
    return { response, text: value.text, json: () => JSON.parse(value.text) };
  }
  return {
    pool,
    db,
    request,
    ctx,
    schedules,
    skills,
    triggers,
    sync,
    service,
    approvalService,
    requestAction,
    services,
    handlers,
    fixture,
    call,
  };
}
