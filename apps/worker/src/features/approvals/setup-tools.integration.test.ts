import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvalRules,
  approvals as approvalRows,
  configurationRevision,
  runs,
} from "@open-bot/db";
import type { v2 } from "@open-bot/agent";
import type { RunSession } from "../../runs/session";
import { TEAMMATE_RULES } from "../teammates";
import { ApprovalService } from "./";
import { APPROVAL_OUTCOMES } from "../../approval-outcomes";
import { SessionRegistry } from "../../runs/registry";
import { ToolHandlers } from "../../tools/handlers";
import * as dbTables from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, ctx, service, services, fixture, call } = toolHarness();

  it("rejects archived targets, cancelled runs and configuration attempts by swarm helpers", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Old", role: "researcher" });
    await db
      .update(dbTables.teammates)
      .set({ archivedAt: new Date() })
      .where(eq(dbTables.teammates.id, target.teammateId));
    expect(
      (
        await call(session, "schedule_task", {
          bot_id: target.teammateId,
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
      "watch_gmail",
      "watch_calendar",
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
        teammateId: session.bot.id,
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
    const actual = new ApprovalService(ctx, new SessionRegistry(), APPROVAL_OUTCOMES);
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
    const actual = new ApprovalService(ctx, new SessionRegistry(), APPROVAL_OUTCOMES);
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
    const actual = new ApprovalService(ctx, new SessionRegistry(), APPROVAL_OUTCOMES);
    const wait = vi
      .spyOn(actual as unknown as { wait(): Promise<"pending"> }, "wait")
      .mockResolvedValue("pending");
    const tools = new ToolHandlers({ ...services, approvals: actual });
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
});
