import { configurationRevision, teammates as teammateRows } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, services, worker } = h;

  it("teammates: creates, edits, and refuses an edit made from a stale copy", async () => {
    const created = await worker.teammates.create({ name: "Grace", role: "engineer" });
    expect(created).toMatchObject({ name: "Grace", chatPath: `/chats/${created.chatId}` });
    const teammateId = created.teammateId;
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

  it("teammates: a change to something besides the profile doesn't refuse an edit", async () => {
    const created = await worker.teammates.create({ name: "Hopper", role: "engineer" });
    const other = await worker.teammates.create({ name: "Lovelace", role: "analyst" });
    const { teammateId, revision } = created;
    // A budget, being made the lead, and a lesson learned all change the row, not the profile.
    await worker.teammates.setBudget({ teammateId, budget: 50, autoApprove: 10 });
    await worker.teammates.setLead({ teammateId: other.teammateId });
    await worker.teammates.setLead({ teammateId });
    await db
      .update(teammateRows)
      .set({ lessonsChangedAt: new Date() })
      .where(eq(teammateRows.id, teammateId));
    const updated = await worker.teammates.update({
      teammateId,
      changes: { role: "staff engineer" },
      expected_revision: revision,
    });
    // An edit to the profile still refuses the copy from before it.
    expect(
      await failure(
        worker.teammates.update({
          teammateId,
          changes: { instructions: "Stale" },
          expected_revision: revision,
        }),
      ),
    ).toMatchObject({ status: 409 });
    // A revision of the whole row, as an older worker handed out, counts while it's current.
    const [row] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
    const legacy = configurationRevision(row);
    expect(legacy).not.toBe(updated.revision);
    const again = await worker.teammates.update({
      teammateId,
      changes: { role: "principal engineer" },
      expected_revision: legacy,
    });
    expect(again.revision).not.toBe(updated.revision);
    expect(
      await failure(
        worker.teammates.update({
          teammateId,
          changes: { role: "manager" },
          expected_revision: legacy,
        }),
      ),
    ).toMatchObject({ status: 409 });
  });
});
