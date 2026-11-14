// The teamwork tools as a teammate calls them: asking another teammate, and handing a request on in
// a group chat. The end-to-end specs for these need a real Codex login (@agent), so the handlers are
// covered here with the real tool dispatcher.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatMembers, chats, runs } from "@open-bot/db";
import type { RunSession } from "../../runs/session";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, service, fixture, call } = toolHarness();

  it("asks another teammate by name, in their main chat", async () => {
    const { session } = await fixture();
    const ada = await service.create({ name: "Ada", role: "researcher" });

    const asked = await call(session, "ask_teammate", {
      teammate: "ada",
      question: "What did the survey say?",
    });
    expect(asked.response.success).toBe(true);
    expect(asked.text).toContain("Asked Ada");
    const queued = await db.select().from(runs).where(eq(runs.teammateId, ada.teammateId));
    expect(queued).toEqual([
      expect.objectContaining({
        chatId: ada.chatId,
        trigger: "question",
        parentRunId: session.run.id,
        prompt: expect.stringContaining("What did the survey say?"),
      }),
    ]);

    const unknown = await call(session, "ask_teammate", { teammate: "Nobody", question: "Hi?" });
    expect(unknown.response.success).toBe(false);
    expect(unknown.text).toContain('No teammate named "Nobody"');
  });

  it("hands a request to a member of the group chat", async () => {
    const { session } = await fixture();
    const ada = await service.create({ name: "Ada", role: "researcher" });
    const [group] = await db.insert(chats).values({ kind: "group", title: "Launch" }).returning();
    await db.insert(chatMembers).values([
      { chatId: group!.id, teammateId: session.teammate.id },
      { chatId: group!.id, teammateId: ada.teammateId },
    ]);
    const inGroup = { ...session, chat: group } as unknown as RunSession;

    const handed = await call(inGroup, "handoff_to_teammate", {
      teammate: "Ada",
      message: "Draft the launch post",
    });
    expect(handed.response.success).toBe(true);
    expect(handed.text).toContain("Handed to Ada");
    const queued = await db
      .select()
      .from(runs)
      .where(and(eq(runs.teammateId, ada.teammateId), eq(runs.chatId, group!.id)));
    expect(queued).toEqual([
      expect.objectContaining({ trigger: "handoff", parentRunId: session.run.id }),
    ]);
    expect(inGroup.putItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "handoff", toBotId: ada.teammateId, toBotName: "Ada" }), // vocabulary: allow
    );

    // Outside a group chat there is nobody to hand to.
    const direct = await call(session, "handoff_to_teammate", { teammate: "Ada", message: "Hi" });
    expect(direct.text).toBe("Handoffs only work in group chats.");
  });

  it("refuses the old parameter name instead of guessing", async () => {
    const { session } = await fixture();
    await service.create({ name: "Ada", role: "researcher" });
    const old = await call(session, "ask_teammate", { bot: "Ada", question: "Hi?" }); // vocabulary: allow
    expect(old.response.success).toBe(false);
    expect(await db.select().from(runs).where(eq(runs.trigger, "question"))).toEqual([]);
  });
});
