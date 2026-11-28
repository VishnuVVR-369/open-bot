import { runs, schedules, triggers } from "@open-bot/db";
import { nextCronRun } from "@open-bot/domain";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { worker, newTeammate } = h;

  it("schedules: saves a routine and says why a reminder can't be saved", async () => {
    const created = await newTeammate("Mary", "planner");
    const schedule = {
      teammateId: created.id,
      title: "Morning brief",
      prompt: "Brief me",
      cron: "0 9 * * *",
      at: null,
      timezone: null,
    };
    const { id } = await worker.schedules.create(schedule);
    await worker.schedules.runNow({ scheduleId: id });
    const [queued] = await h.db.select().from(runs).where(eq(runs.scheduleId, id));
    expect(queued).toMatchObject({ chatId: created.chatId, lane: `schedule:${id}` });
    await worker.schedules.setEnabled({ scheduleId: id, enabled: false });
    expect(
      await failure(
        worker.schedules.update({ ...schedule, scheduleId: id, cron: null, at: "2001-01-01" }),
      ),
    ).toEqual({ status: 400, message: "That time is in the past." });
  });

  it("triggers and hooks: a webhook gets a URL, and an unknown one is a 404", async () => {
    const created = await newTeammate("Ida", "watcher");
    const hook = await worker.triggers.create({
      teammateId: created.id,
      kind: "webhook",
      title: "Deploys",
      prompt: "Tell me about deploys",
    });
    expect(hook.hookPath).toMatch(/^\/api\/hooks\/[\w-]+$/);
    const { token } = await worker.triggers.rotateToken({ triggerId: hook.id });
    expect(hook.hookPath).not.toContain(token);
    const fired = await worker.hooks.fire({
      token,
      method: "POST",
      contentType: "",
      body: "",
      query: "",
    });
    const [queued] = await h.db.select().from(runs).where(eq(runs.id, fired.runId));
    expect(queued).toMatchObject({ chatId: created.chatId, lane: `trigger:${hook.id}` });
    await worker.triggers.setEnabled({ triggerId: hook.id, enabled: false });
    expect(
      await failure(
        worker.hooks.fire({ token, method: "POST", contentType: "", body: "", query: "" }),
      ),
    ).toEqual({ status: 409, message: "This webhook is paused" });
    expect(
      await failure(
        worker.hooks.fire({ token: "nope", method: "POST", contentType: "", body: "", query: "" }),
      ),
    ).toEqual({ status: 404, message: "Unknown webhook" });
  });

  it("schedules.patch: changes only the name or timing given, in the schedule's time zone", async () => {
    const created = await newTeammate("Noor", "planner");
    const { id } = await worker.schedules.create({
      teammateId: created.id,
      title: "Morning brief",
      prompt: "Brief me",
      cron: "0 9 * * *",
      at: null,
      timezone: "Asia/Kolkata",
      quiet: true,
    });
    // Changed on the web meanwhile: a rename from the phone keeps it.
    await h.db.update(schedules).set({ prompt: "Brief me, shorter" }).where(eq(schedules.id, id));
    await worker.schedules.patch({ scheduleId: id, title: "  Daily brief " });
    const [renamed] = await h.db.select().from(schedules).where(eq(schedules.id, id));
    expect(renamed).toMatchObject({
      title: "Daily brief",
      prompt: "Brief me, shorter",
      cron: "0 9 * * *",
      quiet: true,
      timezone: "Asia/Kolkata",
    });

    await worker.schedules.patch({ scheduleId: id, timing: { cron: "30 7 * * 1-5", at: null } });
    const [retimed] = await h.db.select().from(schedules).where(eq(schedules.id, id));
    expect(retimed).toMatchObject({ kind: "cron", cron: "30 7 * * 1-5", title: "Daily brief" });
    const expected = nextCronRun("30 7 * * 1-5", "Asia/Kolkata").getTime();
    expect(Math.abs(retimed!.nextRunAt!.getTime() - expected)).toBeLessThan(60_000);

    // A reminder's time is wall-clock in the schedule's zone, and a reminder is never quiet.
    await worker.schedules.patch({
      scheduleId: id,
      timing: { cron: null, at: "2099-01-02T09:00" },
    });
    const [reminder] = await h.db.select().from(schedules).where(eq(schedules.id, id));
    expect(reminder).toMatchObject({ kind: "once", cron: null, quiet: false });
    expect(reminder!.runAt!.toISOString()).toBe("2099-01-02T03:30:00.000Z");

    expect(await failure(worker.schedules.patch({ scheduleId: id, title: "   " }))).toEqual({
      status: 400,
      message: "Give it a name.",
    });
    expect(
      await failure(
        worker.schedules.patch({ scheduleId: id, timing: { cron: null, at: "2001-01-01T09:00" } }),
      ),
    ).toEqual({ status: 400, message: "That time is in the past." });
    expect(
      await failure(
        worker.schedules.patch({ scheduleId: id, timing: { cron: "0 8 * *", at: null } }),
      ),
    ).toEqual({ status: 400, message: "Use a 5-field cron expression, like 0 8 * * 1-5." });
    await worker.schedules.remove({ scheduleId: id });
    expect(await failure(worker.schedules.patch({ scheduleId: id, title: "Gone" }))).toEqual({
      status: 404,
      message: "That schedule was deleted.",
    });
  });

  it("schedules.patch: a reminder that already ran runs again at its new time", async () => {
    const created = await newTeammate("Omar", "assistant");
    const { id } = await worker.schedules.create({
      teammateId: created.id,
      title: "Call the bank",
      prompt: "Remind me to call the bank",
      cron: null,
      at: "2099-03-01T10:00",
      timezone: "UTC",
    });
    // What the scheduler leaves once it ran.
    await h.db
      .update(schedules)
      .set({ enabled: false, lastRunAt: new Date() })
      .where(eq(schedules.id, id));
    await worker.schedules.patch({ scheduleId: id, title: "Call the bank again" });
    const [renamed] = await h.db.select().from(schedules).where(eq(schedules.id, id));
    expect(renamed).toMatchObject({ enabled: false, title: "Call the bank again" });
    await worker.schedules.patch({
      scheduleId: id,
      timing: { cron: null, at: "2099-03-02T10:00" },
    });
    const [again] = await h.db.select().from(schedules).where(eq(schedules.id, id));
    expect(again).toMatchObject({ enabled: true, lastRunAt: null });
    expect(again!.nextRunAt!.toISOString()).toBe("2099-03-02T10:00:00.000Z");
  });

  it("schedules.runNow: asking again with the same run id starts one run", async () => {
    const created = await newTeammate("Lena", "planner");
    const schedule = {
      teammateId: created.id,
      title: "Inbox sweep",
      prompt: "Sweep my inbox",
      cron: "0 9 * * *",
      at: null,
      timezone: null,
    };
    const { id } = await worker.schedules.create(schedule);
    const other = await worker.schedules.create({ ...schedule, title: "Another" });
    const runId = randomUUID();
    // Asked again after an answer that was lost (a race between two asks is in
    // schedule-writes.integration.test.ts).
    await worker.schedules.runNow({ scheduleId: id, runId });
    await worker.schedules.runNow({ scheduleId: id, runId });
    const started = await h.db.select().from(runs).where(eq(runs.scheduleId, id));
    expect(started.map((run) => run.id)).toEqual([runId]);
    expect(await failure(worker.schedules.runNow({ scheduleId: other.id, runId }))).toEqual({
      status: 409,
      message: "That run id was already used for something else.",
    });
    // Without an id, each ask is its own run.
    await worker.schedules.runNow({ scheduleId: id });
    expect(await h.db.select().from(runs).where(eq(runs.scheduleId, id))).toHaveLength(2);
  });

  it("triggers.patch: changes only the name, interval or lead time given", async () => {
    const created = await newTeammate("Rui", "watcher");
    // Checked a little while ago, so nothing is due and the checker leaves it alone.
    const lastCheckedAt = new Date(Date.now() - 10 * 60_000);
    const [watch] = await h.db
      .insert(triggers)
      .values({
        teammateId: created.id,
        kind: "watch",
        title: "Kettle price",
        prompt: "Tell me the price",
        url: "https://shop.example/kettle",
        intervalMinutes: 60,
        lookFor: "in stock",
        lastCheckedAt,
        createdBy: "user",
      })
      .returning();
    await worker.triggers.patch({ triggerId: watch!.id, title: "Kettle", intervalMinutes: 360 });
    const [watched] = await h.db.select().from(triggers).where(eq(triggers.id, watch!.id));
    expect(watched).toMatchObject({
      title: "Kettle",
      intervalMinutes: 360,
      url: "https://shop.example/kettle",
      lookFor: "in stock",
      prompt: "Tell me the price",
    });
    // A new interval counts from the last check.
    expect(watched!.nextCheckAt!.getTime()).toBe(lastCheckedAt.getTime() + 360 * 60_000);
    expect(
      await failure(worker.triggers.patch({ triggerId: watch!.id, intervalMinutes: 1 })),
    ).toEqual({ status: 400, message: "Check between every 5 minutes and once a week." });
    expect(await failure(worker.triggers.patch({ triggerId: watch!.id, leadMinutes: 15 }))).toEqual(
      {
        status: 400,
        message: "Only a Calendar trigger wakes before an event.",
      },
    );

    // A Gmail trigger whose account was removed can still be renamed; its timing is fixed.
    const [gmail] = await h.db
      .insert(triggers)
      .values({
        teammateId: created.id,
        kind: "gmail",
        title: "Invoices",
        prompt: "File invoices",
        query: "subject:invoice",
        createdBy: "user",
      })
      .returning();
    await worker.triggers.patch({ triggerId: gmail!.id, title: "Bills" });
    const [renamed] = await h.db.select().from(triggers).where(eq(triggers.id, gmail!.id));
    expect(renamed).toMatchObject({ title: "Bills", query: "subject:invoice" });
    expect(
      await failure(worker.triggers.patch({ triggerId: gmail!.id, intervalMinutes: 60 })),
    ).toEqual({ status: 400, message: "Only a page watch checks on an interval." });

    const [calendar] = await h.db
      .insert(triggers)
      .values({
        teammateId: created.id,
        kind: "calendar",
        title: "Meeting prep",
        prompt: "Brief me",
        query: "guests",
        leadMinutes: 30,
        lastError: "Calendar said no",
        nextCheckAt: new Date("2099-01-01T00:00:00Z"),
        createdBy: "user",
      })
      .returning();
    await worker.triggers.patch({ triggerId: calendar!.id, leadMinutes: 60 });
    const [calendared] = await h.db.select().from(triggers).where(eq(triggers.id, calendar!.id));
    // A new lead time looks at the calendar again, right away.
    expect(calendared).toMatchObject({ leadMinutes: 60, query: "guests", lastError: null });
    expect(calendared!.nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      await failure(worker.triggers.patch({ triggerId: calendar!.id, leadMinutes: -5 })),
    ).toEqual({ status: 400, message: "Wake it between when the event starts and a week before." });

    await worker.triggers.remove({ triggerId: watch!.id });
    expect(await failure(worker.triggers.patch({ triggerId: watch!.id, title: "Gone" }))).toEqual({
      status: 404,
      message: "That automation was deleted.",
    });
  });
});
