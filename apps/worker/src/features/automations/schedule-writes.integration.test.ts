// Schedule writes that race each other, and the daily check-in, over the worker's internal API.
// Races are made deterministic by holding a row or index entry in another transaction until the
// write under test waits on it (`racedWhileLocked`).
import { runs, schedules, teammates } from "@open-bot/db";
import { DAILY_CHECK_IN, nextCronRun } from "@open-bot/domain";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { failure, rpcEnabled, rpcHarness } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("schedule writes, end to end", () => {
  const h = rpcHarness();
  const { worker, newTeammate, racedWhileLocked } = h;

  const routine = (teammateId: string, title: string) =>
    worker.schedules.create({
      teammateId,
      title,
      prompt: "Sweep my inbox",
      cron: "0 9 * * *",
      at: null,
      timezone: "UTC",
    });

  /** Another run saving `runId` for `scheduleId`, still uncommitted while the ask waits on it. */
  const savingRun = (created: { id: string; chatId: string }, scheduleId: string, runId: string) =>
    [
      `insert into runs (id, chat_id, teammate_id, trigger, prompt, schedule_id) values ($1, $2, $3, 'schedule', 'Go', $4)`,
      [runId, created.chatId, created.id, scheduleId],
    ] as const;

  it("runNow: says whether this ask started the run or an earlier one did", async () => {
    const created = await newTeammate("Lena", "planner");
    const { id } = await routine(created.id, "Inbox sweep");
    const runId = randomUUID();
    expect(await worker.schedules.runNow({ scheduleId: id, runId })).toEqual({
      ok: true,
      started: true,
    });
    // Asked again after the answer was lost: the earlier ask started it, and nothing more starts.
    expect(await worker.schedules.runNow({ scheduleId: id, runId })).toEqual({
      ok: true,
      started: false,
    });
    expect(await worker.schedules.runNow({ scheduleId: id })).toEqual({ ok: true, started: true });
    expect(await h.db.select().from(runs).where(eq(runs.scheduleId, id))).toHaveLength(2);
  });

  it("runNow: the same ask sent twice at once starts one run, and says the second didn't", async () => {
    const created = await newTeammate("Mia", "planner");
    const { id } = await routine(created.id, "Inbox sweep");
    const runId = randomUUID();
    // The first ask's save is still uncommitted when the second checks the id and saves it.
    const [lock, params] = savingRun(created, id, runId);
    const [answer] = await racedWhileLocked(
      lock,
      () => [worker.schedules.runNow({ scheduleId: id, runId })],
      [...params],
    );
    expect(answer).toEqual({ ok: true, started: false });
    const saved = await h.db.select().from(runs).where(eq(runs.scheduleId, id));
    expect(saved.map((run) => run.id)).toEqual([runId]);
  });

  it("runNow: an id another schedule takes between the check and the save is refused", async () => {
    const created = await newTeammate("Noa", "planner");
    const mine = await routine(created.id, "Mine");
    const theirs = await routine(created.id, "Theirs");
    const runId = randomUUID();
    const [lock, params] = savingRun(created, theirs.id, runId);
    const [refused] = await racedWhileLocked(
      lock,
      () => [failure(worker.schedules.runNow({ scheduleId: mine.id, runId }))],
      [...params],
    );
    expect(refused).toEqual({
      status: 409,
      message: "That run id was already used for something else.",
    });
    expect(await h.db.select().from(runs).where(eq(runs.scheduleId, mine.id))).toEqual([]);
  });

  it("runNow: a schedule whose teammate is archived says so instead of starting nothing", async () => {
    const created = await newTeammate("Oli", "planner");
    const { id } = await routine(created.id, "Inbox sweep");
    await h.db
      .update(teammates)
      .set({ archivedAt: new Date() })
      .where(eq(teammates.id, created.id));
    expect(await failure(worker.schedules.runNow({ scheduleId: id }))).toEqual({
      status: 409,
      message: "Its teammate is archived, so it can't run.",
    });
  });

  it("setEnabled: turning one on while it's retimed runs it on the new time", async () => {
    const created = await newTeammate("Pia", "planner");
    const { id } = await routine(created.id, "Inbox sweep");
    await worker.schedules.setEnabled({ scheduleId: id, enabled: false });
    // A retime holds the row while the switch is turned on.
    await racedWhileLocked(
      `update schedules set cron = '30 18 * * *', next_run_at = $2 where id = $1`,
      () => [worker.schedules.setEnabled({ scheduleId: id, enabled: true })],
      [id, nextCronRun("30 18 * * *", "UTC")],
    );
    const [row] = await h.db.select().from(schedules).where(eq(schedules.id, id));
    expect(row).toMatchObject({ enabled: true, cron: "30 18 * * *" });
    const expected = nextCronRun("30 18 * * *", "UTC").getTime();
    expect(Math.abs(row!.nextRunAt!.getTime() - expected)).toBeLessThan(60_000);
    expect(row!.nextRunAt!.getUTCHours()).toBe(18);
  });

  it("setCheckIn: finds the check-in renamed and retimed, and never adds a second", async () => {
    const created = await newTeammate("Quinn", "assistant");
    const checkIns = () =>
      h.db
        .select()
        .from(schedules)
        .where(and(eq(schedules.teammateId, created.id), eq(schedules.checkIn, true)));
    // Two asks at once add one.
    await Promise.all([
      worker.schedules.setCheckIn({ teammateId: created.id, on: true }),
      worker.schedules.setCheckIn({ teammateId: created.id, on: true }),
    ]);
    const [added, ...more] = await checkIns();
    expect(more).toEqual([]);
    expect(added).toMatchObject({
      title: DAILY_CHECK_IN.title,
      cron: DAILY_CHECK_IN.cron,
      quiet: true,
      enabled: true,
    });
    // Renamed and retimed on the phone, it's still the check-in the switch turns off and on.
    await worker.schedules.patch({
      scheduleId: added!.id,
      title: "Morning look",
      timing: { cron: "0 7 * * 1-5", at: null },
    });
    await worker.schedules.setCheckIn({ teammateId: created.id, on: false });
    expect(await checkIns()).toMatchObject([{ id: added!.id, enabled: false }]);
    await worker.schedules.setCheckIn({ teammateId: created.id, on: true });
    expect(await checkIns()).toMatchObject([
      { id: added!.id, title: "Morning look", cron: "0 7 * * 1-5", enabled: true },
    ]);
    // A routine the owner calls "Daily check-in" isn't it.
    const own = await worker.schedules.create({
      teammateId: created.id,
      title: DAILY_CHECK_IN.title,
      prompt: "My own",
      cron: "0 9 * * *",
      at: null,
      timezone: "UTC",
      quiet: true,
    });
    await worker.schedules.setCheckIn({ teammateId: created.id, on: false });
    const [mine] = await h.db.select().from(schedules).where(eq(schedules.id, own.id));
    expect(mine).toMatchObject({ enabled: true, checkIn: false });
  });

  it("setCheckIn: one added meanwhile by something else is turned on, not added again", async () => {
    const created = await newTeammate("Rory", "assistant");
    // A paused check-in being added for this teammate (as a template's starters are), uncommitted
    // while the switch's own insert waits on its index entry.
    const [answer] = await racedWhileLocked(
      `insert into schedules (teammate_id, title, prompt, kind, cron, timezone, quiet, check_in, enabled, created_by)
       values ($1, 'Daily check-in', 'Look around', 'cron', '0 9 * * *', 'UTC', true, true, false, 'user')`,
      () => [worker.schedules.setCheckIn({ teammateId: created.id, on: true })],
      [created.id],
    );
    expect(answer).toEqual({ ok: true });
    const rows = await h.db.select().from(schedules).where(eq(schedules.teammateId, created.id));
    expect(rows).toMatchObject([{ checkIn: true, enabled: true, prompt: "Look around" }]);
  });

  it("setCheckIn: marks a check-in added without its mark during a deploy, instead of adding one", async () => {
    const created = await newTeammate("Sami", "assistant");
    // What a web app from before the mark adds: the check-in's routine, unmarked.
    const unmarked = await worker.schedules.create({
      teammateId: created.id,
      title: DAILY_CHECK_IN.title,
      prompt: DAILY_CHECK_IN.prompt,
      cron: DAILY_CHECK_IN.cron,
      at: null,
      timezone: "UTC",
      quiet: true,
    });
    await worker.schedules.setCheckIn({ teammateId: created.id, on: false });
    const rows = () => h.db.select().from(schedules).where(eq(schedules.teammateId, created.id));
    expect(await rows()).toMatchObject([{ id: unmarked.id, checkIn: true, enabled: false }]);
    await worker.schedules.setCheckIn({ teammateId: created.id, on: true });
    expect(await rows()).toMatchObject([{ id: unmarked.id, checkIn: true, enabled: true }]);
  });

  it("update: the check-in stays with its teammate", async () => {
    const ada = await newTeammate("Tess", "assistant");
    const bo = await newTeammate("Uma", "assistant");
    await worker.schedules.setCheckIn({ teammateId: ada.id, on: true });
    await worker.schedules.setCheckIn({ teammateId: bo.id, on: true });
    const [checkIn] = await h.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.teammateId, ada.id), eq(schedules.checkIn, true)));
    expect(
      await failure(
        worker.schedules.update({
          scheduleId: checkIn!.id,
          teammateId: bo.id,
          title: checkIn!.title,
          prompt: checkIn!.prompt,
          cron: checkIn!.cron,
          at: null,
          timezone: checkIn!.timezone,
        }),
      ),
    ).toEqual({
      status: 409,
      message:
        "The daily check-in stays with its teammate. Add a routine for the other teammate instead.",
    });
    const [after] = await h.db.select().from(schedules).where(eq(schedules.id, checkIn!.id));
    expect(after).toMatchObject({ teammateId: ada.id, checkIn: true });
  });

  it("setCheckIn: the check-in can't become a one-time reminder", async () => {
    const created = await newTeammate("Remy", "assistant");
    await worker.schedules.setCheckIn({ teammateId: created.id, on: true });
    const [checkIn] = await h.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.teammateId, created.id), eq(schedules.checkIn, true)));
    const repeats = {
      status: 400,
      message: "The daily check-in repeats. Pick when it runs each time.",
    };
    expect(
      await failure(
        worker.schedules.patch({
          scheduleId: checkIn!.id,
          timing: { cron: null, at: "2099-01-02T09:00" },
        }),
      ),
    ).toEqual(repeats);
    expect(
      await failure(
        worker.schedules.update({
          scheduleId: checkIn!.id,
          teammateId: created.id,
          title: checkIn!.title,
          prompt: checkIn!.prompt,
          cron: null,
          at: "2099-01-02T09:00",
          timezone: null,
        }),
      ),
    ).toEqual(repeats);
    expect(
      await failure(worker.schedules.setCheckIn({ teammateId: randomUUID(), on: true })),
    ).toEqual({ status: 404, message: "That teammate no longer exists." });
  });
});
