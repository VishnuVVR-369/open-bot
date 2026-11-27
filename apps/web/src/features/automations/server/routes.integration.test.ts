import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { randomUUID } from "node:crypto";
import { DAILY_CHECK_IN } from "@open-bot/domain";
import { ORPCError } from "@orpc/client";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { database, ids, owned, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("turns a daily check-in on or off through the worker, which finds it by its mark", async () => {
    const path = `/internal/teammates/${ids.teammate}/check-in`;
    answers.set(path, { status: 200, body: { ok: true } });
    try {
      await api.schedules.setCheckIn({ teammateId: ids.teammate, on: true });
      await api.schedules.setCheckIn({ teammateId: ids.teammate, on: false });
      expect(workerBodies.filter((b) => b.path === path).map((b) => b.body)).toEqual([
        { on: true },
        { on: false },
      ]);
      // A worker from before the route: nothing is written in its place.
      const before = workerBodies.length;
      answers.set(path, { status: 404, body: { error: "not found", code: "NOT_FOUND" } });
      await expect(
        api.schedules.setCheckIn({ teammateId: ids.teammate, on: true }),
      ).rejects.toMatchObject({
        message: "open-bot is finishing an update, so nothing changed. Try again in a minute.",
      });
      expect(workerBodies.slice(before).map((b) => b.path)).toEqual([path]);
    } finally {
      answers.clear();
    }
  });

  it("says whether Run now started the run, and that an older worker did", async () => {
    const path = `/internal/schedules/${ids.schedule}/run`;
    const runId = randomUUID();
    try {
      answers.set(path, { status: 200, body: { ok: true, started: false } });
      expect(await api.schedules.runNow({ scheduleId: ids.schedule, runId })).toEqual({
        ok: true,
        started: false,
      });
      // A worker from before `started` ignores the run id and always starts one.
      answers.set(path, { status: 200, body: { ok: true } });
      expect(await api.schedules.runNow({ scheduleId: ids.schedule, runId })).toEqual({
        ok: true,
        started: true,
      });
    } finally {
      answers.clear();
    }
  });

  it("lists which schedule is the daily check-in", async () => {
    const s = await import("@open-bot/db");
    const { eq } = await import("drizzle-orm");
    const [marked] = await database.db
      .insert(s.schedules)
      .values({
        ...owned(ids.teammate),
        title: "Morning look",
        prompt: DAILY_CHECK_IN.prompt,
        kind: "cron",
        cron: DAILY_CHECK_IN.cron,
        timezone: "Europe/Berlin",
        quiet: true,
        checkIn: true,
        createdBy: "user",
      })
      .returning({ id: s.schedules.id });
    try {
      const listed = await api.schedules.list();
      expect(listed.find((row) => row.id === marked!.id)).toMatchObject({ checkIn: true });
      expect(listed.find((row) => row.id === ids.schedule)).toMatchObject({ checkIn: false });
    } finally {
      await database.db.delete(s.schedules).where(eq(s.schedules.id, marked!.id));
    }
  });

  it("sends a webhook a test request only while it exists", async () => {
    const s = await import("@open-bot/db");
    // A page watch has no URL to call.
    await expect(api.triggers.test({ triggerId: ids.trigger })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "That webhook no longer exists.",
    });
    const [hook] = await database.db
      .insert(s.triggers)
      .values({
        ...owned(ids.teammate),
        kind: "webhook",
        title: "Deploys",
        prompt: "Tell me about failed deploys",
        token: "hook-token",
        createdBy: "user",
      })
      .returning({ id: s.triggers.id });
    const runId = randomUUID();
    answers.set("/internal/hooks/hook-token", { status: 200, body: { runId } });
    try {
      expect(await api.triggers.test({ triggerId: hook!.id })).toEqual({ runId });
      expect(
        workerBodies.findLast((b) => b.path === "/internal/hooks/hook-token")?.body,
      ).toMatchObject({ method: "POST", contentType: "application/json" });
    } finally {
      answers.clear();
    }
  });

  it("sends the phone's rename and timing edits to the worker's patch, and nothing else", async () => {
    answers.set(`/internal/schedules/${ids.schedule}/patch`, {
      status: 200,
      body: { id: ids.schedule },
    });
    answers.set(`/internal/triggers/${ids.trigger}/patch`, {
      status: 200,
      body: { id: ids.trigger },
    });
    const runId = randomUUID();
    const before = workerBodies.length;
    answers.set(`/internal/schedules/${ids.schedule}/run`, {
      status: 200,
      body: { ok: true, started: true },
    });
    try {
      await api.schedules.patch({
        scheduleId: ids.schedule,
        timing: { cron: "30 7 * * 1-5", at: null },
      });
      await api.triggers.patch({ triggerId: ids.trigger, title: "Kettle", intervalMinutes: 360 });
      await api.schedules.runNow({ scheduleId: ids.schedule, runId });
      const sent = workerBodies
        .slice(before)
        .filter(
          (b) => b.path.endsWith("/patch") || b.path === `/internal/schedules/${ids.schedule}/run`,
        );
      expect(sent).toEqual([
        {
          path: `/internal/schedules/${ids.schedule}/patch`,
          body: { timing: { cron: "30 7 * * 1-5", at: null } },
        },
        {
          path: `/internal/triggers/${ids.trigger}/patch`,
          body: { title: "Kettle", intervalMinutes: 360 },
        },
        { path: `/internal/schedules/${ids.schedule}/run`, body: { runId } },
      ]);
      // A patch that changes nothing isn't sent.
      await expect(api.schedules.patch({ scheduleId: ids.schedule })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    } finally {
      answers.clear();
    }
  });

  it("refuses an edit with nothing changed while the worker is from before patch", async () => {
    const noRoute = { status: 404, body: { error: "not found", code: "NOT_FOUND" } };
    answers.set(`/internal/schedules/${ids.schedule}/patch`, noRoute);
    answers.set(`/internal/triggers/${ids.trigger}/patch`, noRoute);
    try {
      const before = workerBodies.length;
      for (const call of [
        api.schedules.patch({ scheduleId: ids.schedule, title: "Renamed" }),
        api.triggers.patch({ triggerId: ids.trigger, title: "Renamed" }),
      ]) {
        const error = await call.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ORPCError);
        expect((error as ORPCError<string, unknown>).message).toBe(
          "open-bot is finishing an update, so nothing changed. Try again in a minute.",
        );
      }
      // No full update was sent in its place, which could undo an edit made meanwhile.
      expect(workerBodies.slice(before).map((b) => b.path)).toEqual([
        `/internal/schedules/${ids.schedule}/patch`,
        `/internal/triggers/${ids.trigger}/patch`,
      ]);
      // The worker's own 404 is passed on as the automation being gone.
      answers.set(`/internal/schedules/${ids.schedule}/patch`, {
        status: 404,
        body: { error: "That schedule was deleted.", code: "NOT_FOUND" },
      });
      await expect(
        api.schedules.patch({ scheduleId: ids.schedule, title: "Renamed" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "That schedule was deleted." });
    } finally {
      answers.clear();
    }
  });
});
