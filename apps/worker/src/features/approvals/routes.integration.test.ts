import { approvals } from "@open-bot/db";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, worker, teammateWithRun } = h;

  it("approvals: decides once, and says how one decided elsewhere ended", async () => {
    const { created, run } = await teammateWithRun();
    const [approval] = await db
      .insert(approvals)
      .values({
        runId: run.id,
        teammateId: created.id,
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
});
