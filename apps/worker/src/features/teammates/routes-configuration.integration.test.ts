import {
  teammates as teammateRows,
  instructionProposals,
  schedules as scheduleRows,
} from "@open-bot/db";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { teammateRouteHarness } from "./testing-routes";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { pool, db, sync, teammates, worker, teammateWithRun } = h;

  describe("teammate writes", () => {
    const { imported, leads } = teammateRouteHarness(h);

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
            eq(instructionProposals.teammateId, teammateId),
          ),
        );
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
            eq(instructionProposals.teammateId, teammateId),
          ),
        );
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

    it("takes suggested instructions only as reviewed, and not for an archived teammate", async () => {
      const { teammateId } = await imported("Reviewer");
      const instructions = async () =>
        (await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId)))[0]!
          .instructions;
      const suggest = async (proposed: string) => {
        await teammates.proposeInstructions({
          teammateId,
          current: await instructions(),
          proposed,
          reason: "Clearer",
          runId: (await teammateWithRun()).run.id,
        });
        const [waiting] = await db
          .select()
          .from(instructionProposals)
          .where(
            and(
              eq(instructionProposals.status, "pending"),
              eq(instructionProposals.teammateId, teammateId),
            ),
          );
        return waiting!.id;
      };
      const reviewed = await instructions();
      const proposalId = await suggest("Answer in bullets.");
      // Edited on the web after the change was shown against the old instructions.
      await db
        .update(teammateRows)
        .set({ instructions: "Edited on the web." })
        .where(eq(teammateRows.id, teammateId));
      expect(
        await failure(worker.proposals.accept({ proposalId, expectedInstructions: reviewed })),
      ).toEqual({
        status: 409,
        message:
          "The instructions changed since you looked. Review the suggestion again before accepting it.",
      });
      expect(await instructions()).toBe("Edited on the web.");
      // Reviewed again against what's there now, it's taken, and taking it again changes nothing.
      await worker.proposals.accept({ proposalId, expectedInstructions: "Edited on the web." });
      expect(await instructions()).toBe("Answer in bullets.");
      await worker.proposals.accept({ proposalId, expectedInstructions: "Edited on the web." });
      expect(await instructions()).toBe("Answer in bullets.");
      // A teammate archived meanwhile keeps its instructions, whatever the client saw.
      const later = await suggest("Use headings.");
      await db
        .update(teammateRows)
        .set({ archivedAt: new Date(), isLead: false })
        .where(eq(teammateRows.id, teammateId));
      expect(
        await failure(
          worker.proposals.accept({
            proposalId: later,
            expectedInstructions: "Answer in bullets.",
          }),
        ),
      ).toEqual({
        status: 409,
        message: "That teammate was archived, so its instructions can't change.",
      });
      expect(await failure(worker.proposals.accept({ proposalId: later }))).toMatchObject({
        status: 409,
      });
      expect(await instructions()).toBe("Answer in bullets.");
      // The one taken before the archive still answers the same.
      await worker.proposals.accept({ proposalId, expectedInstructions: reviewed });
    });

    it("accepts a suggestion while the teammate makes a newer one, without deadlocking", async () => {
      const { teammateId } = await imported("Racer");
      const instructions = async () =>
        (await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId)))[0]!
          .instructions;
      const before = await instructions();
      const { run } = await teammateWithRun();
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Answer in bullets.",
        reason: "Shorter",
        runId: run.id,
      });
      const [waiting] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.teammateId, teammateId),
            eq(instructionProposals.status, "pending"),
          ),
        );
      // A newer suggestion's order (`addProposal`): it dismisses the waiting one, then adds itself,
      // whose key check reads the teammate's row.
      const newer = await pool.connect();
      try {
        await newer.query("begin");
        await newer.query(
          "update instruction_proposals set status = 'dismissed', decided_at = now() where teammate_id = $1 and status = 'pending'",
          [teammateId],
        );
        const accepting = failure(
          worker.proposals.accept({ proposalId: waiting!.id, expectedInstructions: before }),
        );
        // Wait until accepting waits on the suggestion the newer one holds.
        for (;;) {
          const { rows } = await pool.query<{ waiting: number }>(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          if (rows[0]!.waiting > 0) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        await newer.query(
          "insert into instruction_proposals (teammate_id, current, proposed, reason, run_id) values ($1, '', 'Use headings.', 'Clearer', $2)",
          [teammateId, run.id],
        );
        await newer.query("commit");
        expect(await accepting).toEqual({
          status: 409,
          message: "A newer suggestion replaced this one.",
        });
      } finally {
        // A failed run leaves it inside an aborted transaction: end it before the pool reuses it.
        await newer.query("rollback").catch(() => undefined);
        newer.release();
      }
      expect(await instructions()).toBe(before);
    });

    it("removes a schedule, and a schedule already gone is fine", async () => {
      const { teammateId } = await imported("Planner", {
        routines: [{ title: "Plan", prompt: "Plan", cron: "0 9 * * *", quiet: false }],
      });
      const [routine] = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.teammateId, teammateId));
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
        .set({ archivedAt: new Date(), isLead: false })
        .where(isNull(teammateRows.archivedAt));
      expect(await leads()).toEqual([]);
      await Promise.all(["Ada", "Bea"].map((name) => imported(name)));
      expect(await leads()).toHaveLength(1);
    });
  });
});
