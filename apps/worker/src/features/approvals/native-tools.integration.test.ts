import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals as approvalRows } from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, approvalService, fixture } = toolHarness();

  it("doesn't ask twice about a command the user just approved in this run", async () => {
    const { session } = await fixture("full");
    await db.insert(approvalRows).values({
      runId: session.run.id,
      teammateId: session.bot.id,
      chatId: session.chat.id,
      kind: "action",
      title: "Delete /tmp/old.txt",
      detail: "Run rm -f -- /tmp/old.txt to delete it.",
      status: "approved",
      itemId: "approval-item",
    });
    const asked = await approvalService.requestNative(session, {
      kind: "command",
      subject: "/bin/bash -lc 'rm -f -- /tmp/old.txt'",
      title: "Run `rm -f -- /tmp/old.txt`",
      detail: "$ rm -f -- /tmp/old.txt",
      itemId: "native-item",
    });
    expect(asked).toBe(true);
    // No second request was made.
    expect(
      await db.select().from(approvalRows).where(eq(approvalRows.runId, session.run.id)),
    ).toHaveLength(1);
  });
});
