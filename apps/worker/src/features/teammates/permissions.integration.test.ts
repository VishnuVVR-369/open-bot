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
        (await call(session, "create_teammate", { name: "No", role: "assistant" })).response
          .success,
      ).toBe(false);
    }
    expect(await service.list()).toHaveLength(1);
    await db
      .update(dbTables.teammates)
      .set({ autonomy: "full" })
      .where(eq(dbTables.teammates.id, session.teammate.id));
    const current = await service.get(session.teammate.id);
    requestAction.mockResolvedValueOnce("denied");
    const result = await call(session, "update_teammate", {
      teammate_id: session.teammate.id,
      expected_revision: current.revision,
      changes: { autonomy: "risky" },
    });
    expect(result.response.success).toBe(false);
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ askEveryTime: true }),
    );
    expect((await service.get(session.teammate.id)).autonomy).toBe("full");
  });

  it("rechecks the revision after approval and does not overwrite a user edit made while waiting", async () => {
    const { session } = await fixture("risky");
    const current = await service.get(session.teammate.id);
    requestAction.mockImplementationOnce(async () => {
      await service.update(session.teammate.id, { instructions: "The user's newer instructions" });
      return "approved";
    });
    const result = await call(session, "update_teammate", {
      teammate_id: session.teammate.id,
      expected_revision: current.revision,
      changes: { instructions: "Stale" },
    });
    expect(result.response.success).toBe(false);
    expect((await service.get(session.teammate.id)).instructions).toBe(
      "The user's newer instructions",
    );
  });

  it("takes a whole-row revision, as threads from before profile revisions hold, while it's current", async () => {
    const { session } = await fixture("full");
    const target = await service.create({ name: "Archivist", role: "librarian" });
    const [row] = await db
      .select()
      .from(dbTables.teammates)
      .where(eq(dbTables.teammates.id, target.teammateId));
    const legacy = dbTables.configurationRevision(row);
    expect(legacy).not.toBe(target.revision);
    const saved = await call(session, "update_teammate", {
      teammate_id: target.teammateId,
      expected_revision: legacy,
      changes: { role: "head librarian" },
    });
    expect(saved.response.success).toBe(true);
    expect((await service.get(target.teammateId)).role).toBe("head librarian");
    // The row changed, so the same old revision is stale now.
    const stale = await call(session, "update_teammate", {
      teammate_id: target.teammateId,
      expected_revision: legacy,
      changes: { role: "archivist" },
    });
    expect(stale.response.success).toBe(false);
    expect((await service.get(target.teammateId)).role).toBe("head librarian");
  });

  it("honours a caller's newly restricted autonomy and rejects targets archived during approval", async () => {
    const { session } = await fixture("full");
    const target = await service.create({ name: "Researcher", role: "researcher" });
    await db
      .update(dbTables.teammates)
      .set({ autonomy: "risky" })
      .where(eq(dbTables.teammates.id, session.teammate.id));
    requestAction.mockResolvedValueOnce("denied");
    expect(
      (await call(session, "create_teammate", { name: "No", role: "assistant" })).response.success,
    ).toBe(false);
    requestAction.mockImplementationOnce(async () => {
      await db
        .update(dbTables.teammates)
        .set({ archivedAt: new Date() })
        .where(eq(dbTables.teammates.id, target.teammateId));
      return "approved";
    });
    expect(
      (
        await call(session, "schedule_task", {
          teammate_id: target.teammateId,
          title: "No",
          prompt: "No",
          cron: "0 8 * * *",
        })
      ).response.success,
    ).toBe(false);
    expect(await db.select().from(scheduleRows)).toHaveLength(0);
  });
});
