import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schedules as scheduleRows } from "@open-bot/db";
import * as dbTables from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, service, requestAction, fixture, call } = toolHarness();

  it("enforces denied and pending changes and always approves autonomy changes separately", async () => {
    const { session } = await fixture("risky");
    for (const decision of ["denied", "pending"] as const) {
      requestAction.mockResolvedValueOnce(decision);
      expect(
        (await call(session, "create_bot", { name: "No", role: "assistant" })).response.success,
      ).toBe(false);
    }
    expect(await service.list()).toHaveLength(1);
    await db
      .update(dbTables.bots)
      .set({ autonomy: "full" })
      .where(eq(dbTables.bots.id, session.bot.id));
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
    await db
      .update(dbTables.bots)
      .set({ autonomy: "risky" })
      .where(eq(dbTables.bots.id, session.bot.id));
    requestAction.mockResolvedValueOnce("denied");
    expect(
      (await call(session, "create_bot", { name: "No", role: "assistant" })).response.success,
    ).toBe(false);
    requestAction.mockImplementationOnce(async () => {
      await db
        .update(dbTables.bots)
        .set({ archivedAt: new Date() })
        .where(eq(dbTables.bots.id, target.botId));
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
});
