import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chats, schedules as scheduleRows, skills as skillRows } from "@open-bot/db";
import { TEAMMATE_TEMPLATES } from "@open-bot/domain";
import { TEAMMATE_RULES } from "./";
import * as dbTables from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, sync, service, requestAction, fixture, call } = toolHarness();

  it("creates permanent teammates with unique slugs and only one lead under concurrency", async () => {
    const created = await Promise.all([
      service.create({ name: "Ada", role: "researcher" }),
      service.create({ name: "Ada", role: "researcher" }),
    ]);
    const rows = await db.select().from(dbTables.teammates);
    expect(rows.map((teammate) => teammate.slug).sort()).toEqual(["ada", "ada-2"]);
    expect(rows.filter((teammate) => teammate.isLead)).toHaveLength(1);
    expect(await db.select().from(chats)).toHaveLength(2);
    expect(created.every((teammate) => teammate.chatPath === `/chats/${teammate.chatId}`)).toBe(
      true,
    );
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("discovers templates and installs only selected starter automations plus template skills", async () => {
    const { session } = await fixture();
    const listed = await call(session, "list_teammate_templates");
    expect(listed.json()).toHaveLength(TEAMMATE_TEMPLATES.length);
    const template = TEAMMATE_TEMPLATES.find((entry) => entry.skills?.length)!;
    const created = await call(session, "create_teammate", {
      name: "Scout",
      template_id: template.id,
      starter_ids: [template.starters[0]!.id],
    });
    expect(created.response.success).toBe(true);
    const id = created.json().teammateId;
    expect(
      await db.select().from(scheduleRows).where(eq(scheduleRows.teammateId, id)),
    ).toHaveLength(1);
    expect(await db.select().from(skillRows).where(eq(skillRows.teammateId, id))).toHaveLength(
      template.skills!.length,
    );
    expect((await service.get(id)).autonomy).toBe("risky");
    const all = await call(session, "list_teammates");
    expect(all.json()).toHaveLength(2);
  });

  it("creates a teammate with its own skills and schedules in one approval", async () => {
    const { session } = await fixture("risky");
    const created = await call(session, "create_teammate", {
      name: "Rex",
      role: "market researcher",
      instructions: "Track competitors and brief me weekly.",
      skills: [
        { name: "competitor-brief", description: "Brief on a competitor", instructions: "Steps" },
      ],
      schedules: [
        { title: "Weekly brief", prompt: "Write the weekly brief", cron: "0 9 * * 1" },
        { title: "Kickoff", prompt: "Introduce yourself", at: "2099-01-01 09:00" },
      ],
    });
    expect(created.response.success).toBe(true);
    const result = created.json();
    expect(result).toMatchObject({ name: "Rex", skills: 1, schedules: 2, failed: [] });
    expect(requestAction).toHaveBeenCalledOnce();
    const request = requestAction.mock.calls[0]![1];
    expect(request.title).toBe("Create the teammate Rex");
    expect(request.detail).toContain("Track competitors and brief me weekly.");
    expect(request.detail).toContain("/competitor-brief: Brief on a competitor");
    expect(request.detail).toContain("Weekly brief");
    const rows = await db
      .select()
      .from(scheduleRows)
      .where(eq(scheduleRows.teammateId, result.teammateId));
    expect(rows.map((row) => row.timezone)).toEqual(["Asia/Kolkata", "Asia/Kolkata"]);
    expect((await call(session, "list_teammates")).json()[1]).toMatchObject({
      name: "Rex",
      chatPath: result.chatPath,
    });
  });

  it("refuses an invalid schedule before asking the user anything", async () => {
    const { session } = await fixture("risky");
    const result = await call(session, "create_teammate", {
      name: "Rex",
      role: "researcher",
      schedules: [{ title: "Broken", prompt: "Never", cron: "every monday" }],
    });
    expect(result.response.success).toBe(false);
    expect(result.text).toContain("Broken");
    expect(requestAction).not.toHaveBeenCalled();
    expect(await service.list()).toHaveLength(1);
  });

  it("names the teammate, not its id, when asking to set up its automations", async () => {
    const { session } = await fixture("risky");
    const target = await service.create({ name: "Iris", role: "researcher" });
    await call(session, "schedule_task", {
      teammate_id: target.teammateId,
      title: "Morning brief",
      prompt: "Brief me",
      cron: "0 8 * * *",
    });
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({
        title: 'Schedule "Morning brief" for Iris',
        subject: TEAMMATE_RULES.setup,
      }),
    );
    const [schedule] = await db.select().from(scheduleRows);
    await call(session, "cancel_automation", { teammate_id: target.teammateId, id: schedule!.id });
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ title: 'Delete "Morning brief" for Iris' }),
    );
  });

  it("patches a profile without clearing omitted fields and rejects concurrent stale edits", async () => {
    const created = await service.create({
      name: "Ada",
      role: "researcher",
      instructions: "Be concise",
      emoji: "🔎",
    });
    const original = await service.get(created.teammateId);
    const results = await Promise.allSettled([
      service.update(created.teammateId, { name: "Iris" }, original.revision),
      service.update(created.teammateId, { name: "Rex" }, original.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = await service.get(created.teammateId);
    expect(saved.instructions).toBe("Be concise");
    expect(saved.emoji).toBe("🔎");
    expect(saved.role).toBe("researcher");
    const [chat] = await db.select().from(chats).where(eq(chats.id, created.chatId));
    expect(chat!.title).toBe(saved.name);
  });

  it("reports a saved teammate when the computer is offline, without creating a duplicate", async () => {
    sync.mockRejectedValueOnce(new Error("Offline"));
    const created = await service.create({ name: "Ada", role: "researcher" });
    expect(created.workspaceSynced).toBe(false);
    expect(await service.list()).toHaveLength(1);
  });
});
