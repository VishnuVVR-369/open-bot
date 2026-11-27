import { describe, expect, it } from "vitest";
import { DAILY_CHECK_IN } from "../teammates/templates";
import {
  comingUp,
  dailyCheckInOn,
  describeAccountWatch,
  formatWhen,
  intervalChoices,
  isFinishedReminder,
  leadChoices,
  nextRunLabel,
  runIsHeldBack,
  scheduleCadence,
  shortPageUrl,
} from "./display";

describe("automations as the app shows them", () => {
  it("says when a schedule runs, a reminder on its own zone's clock", () => {
    expect(
      scheduleCadence({ kind: "cron", cron: "0 9 * * 1-5", runAt: null, timezone: "UTC" }),
    ).toBe("Weekdays at 9:00 AM");
    // 03:30 UTC is 9:00 in Kolkata, whatever the viewer's zone.
    expect(
      scheduleCadence({
        kind: "once",
        cron: null,
        runAt: "2026-12-01T03:30:00.000Z",
        timezone: "Asia/Kolkata",
      }),
    ).toBe("Once, Tue Dec 1, 9:00 AM");
    expect(scheduleCadence({ kind: "once", cron: null, runAt: null, timezone: "UTC" })).toBe(
      "Once",
    );
    expect(formatWhen("2026-12-01T15:05:00.000Z", "America/New_York")).toBe("Tue Dec 1, 10:05 AM");
  });

  it("labels the next run today, tomorrow, or by weekday", () => {
    const now = new Date(2026, 10, 28, 8, 0);
    expect(nextRunLabel(new Date(2026, 10, 28, 16, 0), now)).toBe("Today 4:00 PM");
    expect(nextRunLabel(new Date(2026, 10, 29, 8, 0), now)).toBe("Tomorrow 8:00 AM");
    expect(nextRunLabel(new Date(2026, 11, 2, 0, 5), now)).toBe("Wed 12:05 AM");
  });

  it("holds a due run back only while the computer is offline", () => {
    const now = Date.parse("2026-11-07T00:00:00Z");
    expect(runIsHeldBack("2026-11-06T16:00:00Z", now, false)).toBe(true);
    expect(runIsHeldBack("2026-11-07T16:00:00Z", now, false)).toBe(false);
    expect(runIsHeldBack("2026-11-06T16:00:00Z", now, true)).toBe(false);
  });

  it("knows a reminder that already ran, and what comes up next", () => {
    expect(isFinishedReminder({ kind: "once", enabled: false, lastRunAt: "2026-11-01" })).toBe(
      true,
    );
    expect(isFinishedReminder({ kind: "once", enabled: false, lastRunAt: null })).toBe(false);
    expect(isFinishedReminder({ kind: "cron", enabled: false, lastRunAt: "2026-11-01" })).toBe(
      false,
    );
    const rows = [
      { id: "c", enabled: true, nextRunAt: "2026-11-30T09:00:00Z" },
      { id: "off", enabled: false, nextRunAt: "2026-11-28T09:00:00Z" },
      { id: "a", enabled: true, nextRunAt: "2026-11-28T09:00:00Z" },
      { id: "none", enabled: true, nextRunAt: null },
      { id: "b", enabled: true, nextRunAt: "2026-11-29T09:00:00Z" },
      { id: "d", enabled: true, nextRunAt: "2026-12-01T09:00:00Z" },
    ];
    expect(comingUp(rows).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("finds a teammate's daily check-in by its title and quiet flag", () => {
    const checkIn = {
      teammateId: "t1",
      title: DAILY_CHECK_IN.title,
      quiet: true,
      enabled: true,
    };
    expect(dailyCheckInOn([checkIn], "t1")).toBe(true);
    expect(dailyCheckInOn([checkIn], "t2")).toBe(false);
    expect(dailyCheckInOn([{ ...checkIn, enabled: false }], "t1")).toBe(false);
    // A loud schedule with the same name is the owner's own, not the check-in.
    expect(dailyCheckInOn([{ ...checkIn, quiet: false }], "t1")).toBe(false);
  });

  it("describes what a trigger watches in a few words", () => {
    expect(shortPageUrl("https://www.shop.example/kettle/")).toBe("shop.example/kettle");
    expect(describeAccountWatch({ kind: "calendar", query: "guests", leadMinutes: 60 })).toBe(
      "an hour before each event with other people",
    );
    expect(describeAccountWatch({ kind: "calendar", query: "all", leadMinutes: null })).toBe(
      "30 minutes before each event",
    );
    expect(describeAccountWatch({ kind: "gmail", query: null, leadMinutes: null })).toMatch(
      /mail/i,
    );
  });

  it("keeps a timing the menus don't offer as a choice", () => {
    expect(intervalChoices(60).map((choice) => choice.minutes)).toEqual([15, 60, 360, 1440]);
    expect(intervalChoices(90).at(-1)).toEqual({ minutes: 90, label: "Every 90 minutes" });
    expect(leadChoices(120).at(-1)).toEqual({ minutes: 120, label: "2 hours before" });
    expect(leadChoices(null)).toHaveLength(6);
  });
});
