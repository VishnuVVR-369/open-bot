import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chats } from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, service, fixture, call } = toolHarness();

  it("titles a direct chat once, and never over a title the user gave", async () => {
    const { session, created } = await fixture();
    const titled = await call(session, "set_chat_title", { title: '"Plan the launch week."' });
    expect(titled.response.success).toBe(true);
    const [chat] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    expect(chat).toMatchObject({ title: "Plan the launch week", titled: true });

    const again = await call(session, "set_chat_title", { title: "Something else" });
    expect(again.text).toContain("already has a title");
    const [kept] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    expect(kept!.title).toBe("Plan the launch week");

    // Renaming the teammate renames only their chats still named after them.
    const other = await service.create({ name: "Ada", role: "researcher" });
    await service.update(session.bot.id, { name: "Leader" });
    await service.update(other.teammateId, { name: "Ada Lovelace" });
    const [topic] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    const [named] = await db.select().from(chats).where(eq(chats.id, other.chatId));
    expect(topic!.title).toBe("Plan the launch week");
    expect(named!.title).toBe("Ada Lovelace");
  });
});
