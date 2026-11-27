import { describe, expect, it } from "vitest";
import {
  defaultReminderAt,
  sameTiming,
  timingForm,
  timingOf,
  timingProblem,
  timingSummary,
} from "./timing";

const now = new Date("2026-11-28T10:20:00Z");

describe("a schedule's timing as the forms edit it", () => {
  it("opens a routine as its cadence, and saves the same cron back", () => {
    const form = timingForm(
      { kind: "cron", cron: "30 7 * * 3", runAt: null, timezone: "Europe/Berlin" },
      "Europe/Berlin",
      now,
    );
    expect(form).toMatchObject({ kind: "cron", cadence: "weekly", time: "07:30", weekday: "3" });
    expect(timingOf(form)).toEqual({ cron: "30 7 * * 3", at: null });
    expect(timingSummary(form)).toBe("Every Wednesday at 7:30 AM");
    expect(timingOf({ ...form, cadence: "hourly", time: "09:15" })).toEqual({
      cron: "15 * * * *",
      at: null,
    });
    // An expression the cadences can't say stays as it is.
    const custom = timingForm(
      { kind: "cron", cron: "0 9 1 * *", runAt: null, timezone: "UTC" },
      "UTC",
      now,
    );
    expect(custom.cadence).toBe("custom");
    expect(timingOf(custom).cron).toBe("0 9 1 * *");
    expect(timingSummary(custom)).toBe("Monthly on day 1 at 9:00 AM");
  });

  it("opens a reminder on the schedule's own clock, or a time to come once it passed", () => {
    const upcoming = timingForm(
      { kind: "once", cron: null, runAt: "2026-12-01T03:30:00.000Z", timezone: "Asia/Kolkata" },
      "Asia/Kolkata",
      now,
    );
    expect(upcoming).toMatchObject({ kind: "once", at: "2026-12-01T09:00" });
    expect(timingOf(upcoming)).toEqual({ cron: null, at: "2026-12-01T09:00" });
    const passed = timingForm(
      { kind: "once", cron: null, runAt: "2026-11-01T09:00:00.000Z", timezone: "UTC" },
      "UTC",
      now,
    );
    expect(passed.at).toBe("2026-11-28T11:00");
  });

  it("starts a new reminder on the zone's own hour, half an hour to an hour and a half out", () => {
    expect(defaultReminderAt("UTC", now)).toBe("2026-11-28T11:00");
    // 10:20 UTC is 15:50 in Kolkata: on its hour, not on UTC's (16:30).
    expect(defaultReminderAt("Asia/Kolkata", now)).toBe("2026-11-28T17:00");
    expect(defaultReminderAt("UTC", new Date("2026-11-28T10:59:00Z"))).toBe("2026-11-28T12:00");
  });

  it("says why a timing can't be saved, as the worker would", () => {
    const form = timingForm(null, "UTC", now);
    expect(timingProblem(form, "UTC", now)).toBeNull();
    expect(timingProblem({ ...form, cadence: "custom", custom: "0 8 * *" }, "UTC", now)).toBe(
      "Use a 5-field cron expression, like 0 8 * * 1-5.",
    );
    const reminder = { ...form, kind: "once" as const };
    expect(timingProblem({ ...reminder, at: "2026-11-28T10:00" }, "UTC", now)).toBe(
      "That time is in the past.",
    );
    // The same wall-clock time is still to come further west.
    expect(timingProblem({ ...reminder, at: "2026-11-28T10:00" }, "America/New_York", now)).toBe(
      null,
    );
    expect(timingProblem({ ...reminder, at: "soon" }, "UTC", now)).toMatch(/Invalid date-time/);
  });

  it("tells a changed timing from the same one written another way", () => {
    const form = timingForm(
      { kind: "cron", cron: "0 9 * * 1-5", runAt: null, timezone: "UTC" },
      "UTC",
      now,
    );
    expect(sameTiming(form, { ...form, weekday: "4" })).toBe(true);
    expect(sameTiming(form, { ...form, time: "09:30" })).toBe(false);
    expect(sameTiming(form, { ...form, kind: "once" })).toBe(false);
  });
});
