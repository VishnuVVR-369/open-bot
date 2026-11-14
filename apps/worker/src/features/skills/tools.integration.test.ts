import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  schedules as scheduleRows,
  skills as skillRows,
  triggers as triggerRows,
} from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, skills, service, fixture, call } = toolHarness();

  it("targets skills, schedules, watches and webhooks at the selected teammate", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Researcher", role: "researcher" });
    const bot_id = target.teammateId;
    expect(
      (
        await call(session, "save_skill", {
          bot_id,
          name: "brief",
          description: "Write a briefing",
          instructions: "Use sources",
        })
      ).response.success,
    ).toBe(true);
    expect(
      (
        await call(session, "schedule_task", {
          bot_id,
          title: "Briefing",
          prompt: "Write a briefing",
          cron: "0 8 * * 1-5",
        })
      ).response.success,
    ).toBe(true);
    expect(
      (
        await call(session, "watch_page", {
          bot_id,
          title: "News",
          prompt: "Summarise changes",
          url: "https://example.com/news",
        })
      ).response.success,
    ).toBe(true);
    expect(
      (
        await call(session, "create_webhook", {
          bot_id,
          title: "Incoming",
          prompt: "Summarise request",
        })
      ).response.success,
    ).toBe(true);
    const configuration = await call(session, "get_bot", { bot_id });
    expect(configuration.json().skills).toHaveLength(1);
    expect(configuration.json().schedules).toHaveLength(1);
    expect(configuration.json().schedules[0].timezone).toBe("Asia/Kolkata");
    expect(configuration.json().triggers).toHaveLength(2);
    expect(configuration.text).not.toContain('"token"');
    expect((await service.get(session.bot.id)).schedules).toHaveLength(0);
    const [schedule] = await db
      .select()
      .from(scheduleRows)
      .where(eq(scheduleRows.teammateId, bot_id));
    expect(
      (await call(session, "update_automation", { bot_id, id: schedule!.id, enabled: false }))
        .response.success,
    ).toBe(true);
    expect((await call(session, "list_automations", { bot_id })).text).toContain("paused");
    expect((await call(session, "cancel_automation", { id: schedule!.id })).response.success).toBe(
      false,
    );
    expect(
      (await call(session, "cancel_automation", { bot_id, id: schedule!.id })).response.success,
    ).toBe(true);
    const [watch] = await db.select().from(triggerRows).where(eq(triggerRows.teammateId, bot_id));
    expect(
      (
        await call(session, "update_automation", {
          bot_id,
          id: watch!.id,
          title: "Changed",
          enabled: false,
        })
      ).response.success,
    ).toBe(true);
    expect(
      (await call(session, "cancel_automation", { bot_id, id: watch!.id })).response.success,
    ).toBe(true);
  });

  it("edits a target's user-created skill by ID and never moves a shared skill into its scope", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Researcher", role: "researcher" });
    const original = await skills.save(
      { name: "brief", description: "Brief", instructions: "Old", teammateId: target.teammateId },
      { kind: "user" },
    );
    expect(
      (
        await call(session, "save_skill", {
          bot_id: target.teammateId,
          skill_id: original.id,
          name: "brief",
          description: "Brief",
          instructions: "New",
        })
      ).response.success,
    ).toBe(true);
    const [shared] = await db
      .insert(skillRows)
      .values({
        name: "shared-brief",
        description: "Shared",
        instructions: "All",
        teammateId: null,
        createdBy: "bot",
        createdByTeammateId: session.bot.id,
      })
      .returning();
    expect(
      (
        await call(session, "save_skill", {
          bot_id: target.teammateId,
          name: shared!.name,
          description: "Private",
          instructions: "Changed",
        })
      ).response.success,
    ).toBe(false);
    expect(
      (await db.select().from(skillRows).where(eq(skillRows.id, shared!.id)))[0]!.teammateId,
    ).toBeNull();
  });
});
