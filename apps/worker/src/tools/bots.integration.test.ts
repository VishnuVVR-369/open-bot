import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import {
  approvalRules,
  approvals as approvalRows,
  bots,
  chats,
  connections,
  configurationRevision,
  createDb,
  createPool,
  runs,
  schedules as scheduleRows,
  settings,
  skills as skillRows,
  triggers as triggerRows,
} from "@open-bot/db";
import { TEAMMATE_TEMPLATES } from "@open-bot/shared";
import type { v2 } from "@open-bot/agent";
import type { Context } from "../context";
import type { RunSession } from "../runs/session";
import { createHttpServer, type HttpDeps } from "../http";
import { BotService } from "../services/bots";
import { ApprovalService } from "../services/approvals";
import { SessionRegistry } from "../services/registry";
import { ScheduleService } from "../services/schedules";
import { SkillService } from "../services/skills";
import { TriggerService } from "../services/triggers";
import { TEAMMATE_RULES } from "./bots";
import { ToolHandlers } from "./handlers";

const url = process.env.BOT_MANAGEMENT_TEST_DATABASE_URL;

describe.skipIf(!url)("bot management with Postgres", () => {
  const pool = createPool(url ?? "postgres://unused");
  const db = createDb(pool);
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
  const service = new BotService(ctx, schedules, skills, sync);
  const approvalService = new ApprovalService(ctx, new SessionRegistry());
  const requestAction = vi.spyOn(approvalService, "requestAction").mockResolvedValue("approved");
  const dependencies = [
    ctx,
    approvalService,
    {},
    schedules,
    skills,
    triggers,
    {},
    {},
    {},
    {},
    {},
    service,
  ] as unknown as ConstructorParameters<typeof ToolHandlers>;
  const handlers = new ToolHandlers(...dependencies);

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/openbot_bot_management_test")
      throw new Error("Use the disposable openbot_bot_management_test database (pnpm test:bots).");
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url)),
    });
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
    await pool.end();
  });

  async function fixture(autonomy: "full" | "risky" | "everything" = "full") {
    const created = await service.create({ name: "Lead", role: "assistant", autonomy });
    const bot = await service.requireBot(created.botId);
    const [chat] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    const [run] = await db
      .insert(runs)
      .values({
        botId: bot.id,
        chatId: created.chatId,
        trigger: "user",
        prompt: "Create and configure my teammates",
        status: "running",
      })
      .returning();
    const session = {
      bot,
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

  it("creates permanent teammates with unique slugs and only one primary under concurrency", async () => {
    const created = await Promise.all([
      service.create({ name: "Ada", role: "researcher" }),
      service.create({ name: "Ada", role: "researcher" }),
    ]);
    const rows = await db.select().from(bots);
    expect(rows.map((bot) => bot.slug).sort()).toEqual(["ada", "ada-2"]);
    expect(rows.filter((bot) => bot.isPrimary)).toHaveLength(1);
    expect(await db.select().from(chats)).toHaveLength(2);
    expect(created.every((bot) => bot.chatPath === `/chats/${bot.chatId}`)).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("discovers templates and installs only selected starter automations plus template skills", async () => {
    const { session } = await fixture();
    const listed = await call(session, "list_bot_templates");
    expect(listed.json()).toHaveLength(TEAMMATE_TEMPLATES.length);
    const template = TEAMMATE_TEMPLATES.find((entry) => entry.skills?.length)!;
    const created = await call(session, "create_bot", {
      name: "Scout",
      template_id: template.id,
      starter_ids: [template.starters[0]!.id],
    });
    expect(created.response.success).toBe(true);
    const id = created.json().botId;
    expect(await db.select().from(scheduleRows).where(eq(scheduleRows.botId, id))).toHaveLength(1);
    expect(await db.select().from(skillRows).where(eq(skillRows.botId, id))).toHaveLength(
      template.skills!.length,
    );
    expect((await service.get(id)).autonomy).toBe("risky");
    const all = await call(session, "list_bots");
    expect(all.json()).toHaveLength(2);
  });

  it("creates a teammate with its own skills and schedules in one approval", async () => {
    const { session } = await fixture("risky");
    const created = await call(session, "create_bot", {
      name: "Rex",
      role: "market researcher",
      instructions: "Track competitors and brief me weekly.",
      skills: [
        { name: "competitor-brief", description: "Brief on a competitor", instructions: "Steps" },
      ],
      schedules: [
        { title: "Weekly brief", prompt: "Write the weekly brief", cron: "0 9 * * 1" },
        { title: "Kickoff", prompt: "Introduce yourself", at: "2099-01-01 09:00" },
      ],
    });
    expect(created.response.success).toBe(true);
    const result = created.json();
    expect(result).toMatchObject({ name: "Rex", skills: 1, schedules: 2, failed: [] });
    expect(requestAction).toHaveBeenCalledOnce();
    const request = requestAction.mock.calls[0]![1];
    expect(request.title).toBe("Create the teammate Rex");
    expect(request.detail).toContain("Track competitors and brief me weekly.");
    expect(request.detail).toContain("/competitor-brief: Brief on a competitor");
    expect(request.detail).toContain("Weekly brief");
    const rows = await db.select().from(scheduleRows).where(eq(scheduleRows.botId, result.botId));
    expect(rows.map((row) => row.timezone)).toEqual(["Asia/Kolkata", "Asia/Kolkata"]);
    expect((await call(session, "list_bots")).json()[1]).toMatchObject({
      name: "Rex",
      chatPath: result.chatPath,
    });
  });

  it("refuses an invalid schedule before asking the user anything", async () => {
    const { session } = await fixture("risky");
    const result = await call(session, "create_bot", {
      name: "Rex",
      role: "researcher",
      schedules: [{ title: "Broken", prompt: "Never", cron: "every monday" }],
    });
    expect(result.response.success).toBe(false);
    expect(result.text).toContain("Broken");
    expect(requestAction).not.toHaveBeenCalled();
    expect(await service.list()).toHaveLength(1);
  });

  it("names the teammate, not its id, when asking to set up its automations", async () => {
    const { session } = await fixture("risky");
    const target = await service.create({ name: "Iris", role: "researcher" });
    await call(session, "schedule_task", {
      bot_id: target.botId,
      title: "Morning brief",
      prompt: "Brief me",
      cron: "0 8 * * *",
    });
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({
        title: 'Schedule "Morning brief" for Iris',
        subject: TEAMMATE_RULES.setup,
      }),
    );
    const [schedule] = await db.select().from(scheduleRows);
    await call(session, "cancel_automation", { bot_id: target.botId, id: schedule!.id });
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ title: 'Delete "Morning brief" for Iris' }),
    );
  });

  it("patches a profile without clearing omitted fields and rejects concurrent stale edits", async () => {
    const created = await service.create({
      name: "Ada",
      role: "researcher",
      instructions: "Be concise",
      emoji: "🔎",
    });
    const original = await service.get(created.botId);
    const results = await Promise.allSettled([
      service.update(created.botId, { name: "Iris" }, original.revision),
      service.update(created.botId, { name: "Rex" }, original.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = await service.get(created.botId);
    expect(saved.instructions).toBe("Be concise");
    expect(saved.emoji).toBe("🔎");
    expect(saved.role).toBe("researcher");
    const [chat] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    expect(chat!.title).toBe(saved.name);
  });

  it("reports a saved bot when the computer is offline, without creating a duplicate", async () => {
    sync.mockRejectedValueOnce(new Error("Offline"));
    const created = await service.create({ name: "Ada", role: "researcher" });
    expect(created.workspaceSynced).toBe(false);
    expect(await service.list()).toHaveLength(1);
  });

  it("enforces denied and pending changes and always approves autonomy changes separately", async () => {
    const { session } = await fixture("risky");
    for (const decision of ["denied", "pending"] as const) {
      requestAction.mockResolvedValueOnce(decision);
      expect(
        (await call(session, "create_bot", { name: "No", role: "assistant" })).response.success,
      ).toBe(false);
    }
    expect(await service.list()).toHaveLength(1);
    await db.update(bots).set({ autonomy: "full" }).where(eq(bots.id, session.bot.id));
    const current = await service.get(session.bot.id);
    requestAction.mockResolvedValueOnce("denied");
    const result = await call(session, "update_bot", {
      bot_id: session.bot.id,
      expected_revision: current.revision,
      changes: { autonomy: "risky" },
    });
    expect(result.response.success).toBe(false);
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ askEveryTime: true }),
    );
    expect((await service.get(session.bot.id)).autonomy).toBe("full");
  });

  it("rechecks the revision after approval and does not overwrite a user edit made while waiting", async () => {
    const { session } = await fixture("risky");
    const current = await service.get(session.bot.id);
    requestAction.mockImplementationOnce(async () => {
      await service.update(session.bot.id, { instructions: "The user's newer instructions" });
      return "approved";
    });
    const result = await call(session, "update_bot", {
      bot_id: session.bot.id,
      expected_revision: current.revision,
      changes: { instructions: "Stale" },
    });
    expect(result.response.success).toBe(false);
    expect((await service.get(session.bot.id)).instructions).toBe("The user's newer instructions");
  });

  it("honours a caller's newly restricted autonomy and rejects targets archived during approval", async () => {
    const { session } = await fixture("full");
    const target = await service.create({ name: "Researcher", role: "researcher" });
    await db.update(bots).set({ autonomy: "risky" }).where(eq(bots.id, session.bot.id));
    requestAction.mockResolvedValueOnce("denied");
    expect(
      (await call(session, "create_bot", { name: "No", role: "assistant" })).response.success,
    ).toBe(false);
    requestAction.mockImplementationOnce(async () => {
      await db.update(bots).set({ archivedAt: new Date() }).where(eq(bots.id, target.botId));
      return "approved";
    });
    expect(
      (
        await call(session, "schedule_task", {
          bot_id: target.botId,
          title: "No",
          prompt: "No",
          cron: "0 8 * * *",
        })
      ).response.success,
    ).toBe(false);
    expect(await db.select().from(scheduleRows)).toHaveLength(0);
  });

  it("targets skills, schedules, watches and webhooks at the selected teammate", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Researcher", role: "researcher" });
    const bot_id = target.botId;
    expect(
      (
        await call(session, "save_skill", {
          bot_id,
          name: "brief",
          description: "Write a briefing",
          instructions: "Use sources",
        })
      ).response.success,
    ).toBe(true);
    expect(
      (
        await call(session, "schedule_task", {
          bot_id,
          title: "Briefing",
          prompt: "Write a briefing",
          cron: "0 8 * * 1-5",
        })
      ).response.success,
    ).toBe(true);
    expect(
      (
        await call(session, "watch_page", {
          bot_id,
          title: "News",
          prompt: "Summarise changes",
          url: "https://example.com/news",
        })
      ).response.success,
    ).toBe(true);
    expect(
      (
        await call(session, "create_webhook", {
          bot_id,
          title: "Incoming",
          prompt: "Summarise request",
        })
      ).response.success,
    ).toBe(true);
    const configuration = await call(session, "get_bot", { bot_id });
    expect(configuration.json().skills).toHaveLength(1);
    expect(configuration.json().schedules).toHaveLength(1);
    expect(configuration.json().schedules[0].timezone).toBe("Asia/Kolkata");
    expect(configuration.json().triggers).toHaveLength(2);
    expect(configuration.text).not.toContain('"token"');
    expect((await service.get(session.bot.id)).schedules).toHaveLength(0);
    const [schedule] = await db.select().from(scheduleRows).where(eq(scheduleRows.botId, bot_id));
    expect(
      (await call(session, "update_automation", { bot_id, id: schedule!.id, enabled: false }))
        .response.success,
    ).toBe(true);
    expect((await call(session, "list_automations", { bot_id })).text).toContain("paused");
    expect((await call(session, "cancel_automation", { id: schedule!.id })).response.success).toBe(
      false,
    );
    expect(
      (await call(session, "cancel_automation", { bot_id, id: schedule!.id })).response.success,
    ).toBe(true);
    const [watch] = await db.select().from(triggerRows).where(eq(triggerRows.botId, bot_id));
    expect(
      (
        await call(session, "update_automation", {
          bot_id,
          id: watch!.id,
          title: "Changed",
          enabled: false,
        })
      ).response.success,
    ).toBe(true);
    expect(
      (await call(session, "cancel_automation", { bot_id, id: watch!.id })).response.success,
    ).toBe(true);
  });

  it("edits a target's user-created skill by ID and never moves a shared skill into its scope", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Researcher", role: "researcher" });
    const original = await skills.save(
      { name: "brief", description: "Brief", instructions: "Old", botId: target.botId },
      { kind: "user" },
    );
    expect(
      (
        await call(session, "save_skill", {
          bot_id: target.botId,
          skill_id: original.id,
          name: "brief",
          description: "Brief",
          instructions: "New",
        })
      ).response.success,
    ).toBe(true);
    const [shared] = await db
      .insert(skillRows)
      .values({
        name: "shared-brief",
        description: "Shared",
        instructions: "All",
        botId: null,
        createdBy: "bot",
        createdByBotId: session.bot.id,
      })
      .returning();
    expect(
      (
        await call(session, "save_skill", {
          bot_id: target.botId,
          name: shared!.name,
          description: "Private",
          instructions: "Changed",
        })
      ).response.success,
    ).toBe(false);
    expect(
      (await db.select().from(skillRows).where(eq(skillRows.id, shared!.id)))[0]!.botId,
    ).toBeNull();
  });

  it("does not expose credentials and requires approval for connection access even in full auto", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Researcher", role: "researcher" });
    const [row] = await db
      .insert(connections)
      .values({
        name: "github",
        label: "GitHub",
        transport: "http",
        url: "https://example.com/mcp",
        encrypted: "do-not-expose",
        secretNames: ["Authorization"],
        botIds: [session.bot.id],
      })
      .returning();
    const listed = await call(session, "list_bot_connections");
    expect(listed.text).not.toContain("do-not-expose");
    expect(listed.text).not.toContain("Authorization");
    const input = {
      bot_id: target.botId,
      connection_id: row!.id,
      assigned: true,
      expected_revision: listed.json()[0].revision,
    };
    requestAction.mockResolvedValueOnce("denied");
    expect((await call(session, "set_bot_connection", input)).response.success).toBe(false);
    expect((await call(session, "set_bot_connection", input)).response.success).toBe(true);
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ askEveryTime: true }),
    );
    expect((await service.get(target.botId)).connections).toHaveLength(1);
    expect((await call(session, "set_bot_connection", input)).response.success).toBe(false);
    const latest = (await service.listConnections())[0]!;
    requestAction.mockClear();
    const again = await call(session, "set_bot_connection", {
      ...input,
      expected_revision: latest.revision,
    });
    expect(again.json().unchanged).toContain("can already use GitHub");
    expect(requestAction).not.toHaveBeenCalled();
    expect(
      (
        await call(session, "set_bot_connection", {
          ...input,
          assigned: false,
          expected_revision: latest.revision,
        })
      ).response.success,
    ).toBe(true);
    expect((await service.get(target.botId)).connections).toHaveLength(0);
  });

  it("rejects archived targets, cancelled runs and configuration attempts by swarm helpers", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Old", role: "researcher" });
    await db.update(bots).set({ archivedAt: new Date() }).where(eq(bots.id, target.botId));
    expect(
      (
        await call(session, "schedule_task", {
          bot_id: target.botId,
          title: "No",
          prompt: "No",
          cron: "0 8 * * *",
        })
      ).response.success,
    ).toBe(false);
    const helper = { ...session, isHelper: true } as unknown as RunSession;
    for (const tool of [
      "create_bot",
      "update_bot",
      "set_bot_connection",
      "save_skill",
      "schedule_task",
      "watch_page",
      "create_webhook",
    ]) {
      expect((await call(helper, tool, {})).response.success).toBe(false);
    }
    await db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, session.run.id));
    expect(
      (await call(session, "create_bot", { name: "No", role: "researcher" })).response.success,
    ).toBe(false);
    expect(await service.list()).toHaveLength(1);
  });

  it("consumes exact late approval receipts once and rejects reuse for a different change", async () => {
    const { session } = await fixture("risky");
    const operation = { tool: "create_bot", arguments: { name: "Ada", role: "researcher" } };
    const [receipt] = await db
      .insert(approvalRows)
      .values({
        botId: session.bot.id,
        chatId: session.chat.id,
        runId: session.run.id,
        kind: "action",
        itemId: "late",
        title: "Create Ada",
        detail: "Create Ada",
        status: "approved",
        payload: { operation, operationKey: configurationRevision(operation) },
      })
      .returning();
    const resumed = {
      ...session,
      run: { ...session.run, trigger: "approval", parentRunId: session.run.id },
    } as unknown as RunSession;
    const actual = new ApprovalService(ctx, new SessionRegistry());
    const wait = vi
      .spyOn(actual as unknown as { wait(): Promise<"pending"> }, "wait")
      .mockResolvedValue("pending");
    const input = {
      title: "Create Ada",
      detail: "Create Ada",
      itemId: "receipt",
      askEveryTime: true,
      operation,
    };
    // The retried call may list its arguments in another order.
    expect(
      await actual.requestAction(resumed, {
        ...input,
        operation: { arguments: { role: "researcher", name: "Ada" }, tool: "create_bot" },
      }),
    ).toBe("approved");
    expect(wait).not.toHaveBeenCalled();
    expect(
      (await db.select().from(approvalRows).where(eq(approvalRows.id, receipt!.id)))[0]!.payload
        .consumed,
    ).toBe(true);
    expect(await actual.requestAction(resumed, input)).toBe("pending");
    expect(
      await actual.requestAction(resumed, {
        ...input,
        operation: { ...operation, arguments: { name: "Eve", role: "researcher" } },
      }),
    ).toBe("pending");
  });

  it("forces a fresh decision for permission changes despite a matching always-allow rule", async () => {
    const { session } = await fixture();
    const actual = new ApprovalService(ctx, new SessionRegistry());
    vi.spyOn(actual, "rulesFor").mockResolvedValue([
      { kind: "action", pattern: "Change autonomy" },
    ] as Awaited<ReturnType<ApprovalService["rulesFor"]>>);
    const wait = vi
      .spyOn(actual as unknown as { wait(): Promise<"pending"> }, "wait")
      .mockResolvedValue("pending");
    const input = { title: "Change autonomy", detail: "Change risky to full", itemId: "force" };
    expect(await actual.requestAction(session, input)).toBe("approved");
    expect(wait).not.toHaveBeenCalled();
    expect(await actual.requestAction(session, { ...input, askEveryTime: true })).toBe("pending");
    expect(wait).toHaveBeenCalledOnce();
    const [card] = await db.select().from(approvalRows).where(eq(approvalRows.itemId, "force"));
    expect(card!.payload.askEveryTime).toBe(true);
    // Approving it with "always allow" saves no rule.
    expect(await actual.decide(card!.id, "approved", { pattern: "Change autonomy" })).toBe(true);
    expect(await db.select().from(approvalRules)).toHaveLength(0);
  });

  it("lets one 'always allow' cover a kind of teammate change, not just one teammate", async () => {
    const { session } = await fixture("risky");
    const actual = new ApprovalService(ctx, new SessionRegistry());
    const wait = vi
      .spyOn(actual as unknown as { wait(): Promise<"pending"> }, "wait")
      .mockResolvedValue("pending");
    const tools = new ToolHandlers(
      ...(dependencies.map((dependency) =>
        dependency === approvalService ? actual : dependency,
      ) as typeof dependencies),
    );
    const create = (name: string) =>
      tools.handle(session, {
        tool: "create_bot",
        arguments: { name, role: "researcher" },
        callId: crypto.randomUUID(),
        threadId: "thread",
        turnId: "turn",
        namespace: null,
      } as v2.DynamicToolCallParams);
    expect((await create("Ada")).success).toBe(false);
    const [card] = await db.select().from(approvalRows);
    expect(card!.title).toBe("Create the teammate Ada");
    expect(card!.payload.subject).toBe(TEAMMATE_RULES.create);
    await actual.addRule(session.bot.id, "action", card!.payload.subject as string);
    expect((await create("Eve")).success).toBe(true);
    expect(wait).toHaveBeenCalledOnce();
    // More autonomy still asks, rule or not.
    expect(
      (
        await tools.handle(session, {
          tool: "create_bot",
          arguments: { name: "Max", role: "researcher", autonomy: "full" },
          callId: crypto.randomUUID(),
          threadId: "thread",
          turnId: "turn",
          namespace: null,
        } as v2.DynamicToolCallParams)
      ).success,
    ).toBe(false);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("uses the same service for authenticated UI create/update routes and rejects stale UI edits", async () => {
    const server = createHttpServer({ ctx, bots: service } as unknown as HttpDeps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server port");
      const endpoint = `http://127.0.0.1:${address.port}/internal/bots`;
      expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
      const headers = {
        "x-worker-secret": "test-worker-secret",
        "content-type": "application/json",
      };
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ template_id: "unknown" }),
          })
        ).status,
      ).toBe(400);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "UI bot", role: "assistant" }),
      });
      expect(response.status).toBe(200);
      const created = (await response.json()) as { botId: string; revision: string };
      const body = JSON.stringify({
        changes: { name: "Edited" },
        expected_revision: created.revision,
      });
      expect(
        (await fetch(`${endpoint}/${created.botId}`, { method: "POST", headers, body })).status,
      ).toBe(200);
      expect(
        (await fetch(`${endpoint}/${created.botId}`, { method: "POST", headers, body })).status,
      ).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
