import {
  bots as teammateRows, // vocabulary: allow
  chats,
  runs,
  schedules as scheduleRows,
} from "@open-bot/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { teammateRouteHarness } from "./testing-routes";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { pool, db, ctx, worker } = h;

  describe("teammate writes", () => {
    const { owned, imported, row, leads } = teammateRouteHarness(h);

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
  });
});
