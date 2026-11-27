import { describe, expect, it } from "vitest";
import {
  comingUp,
  dailyCheckInOn,
  describeAccountWatch,
  formatWhen,
  intervalChoices,
  isDailyCheckIn,
  isFinishedReminder,
  leadChoices,
  nextRunLabel,
  otherZoneLabel,
  runIsHeldBack,
  scheduleCadence,
  shortPageUrl,
  todayIn,
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

  it("labels the next run today, tomorrow, or by weekday, on the schedule's clock", () => {
    // 8:00 in London is 13:30 in Kolkata, on Sat Nov 28.
    const now = new Date("2026-11-28T08:00:00Z");
    expect(nextRunLabel("2026-11-28T16:00:00Z", "Europe/London", now)).toBe("Today 4:00 PM");
    expect(nextRunLabel("2026-11-29T08:00:00Z", "Europe/London", now)).toBe("Tomorrow 8:00 AM");
    expect(nextRunLabel("2026-12-02T00:05:00Z", "Europe/London", now)).toBe("Wed 12:05 AM");
    // 9:00 on Sun Nov 29 in Kolkata is 3:30 that morning in London: tomorrow on both clocks, but
    // at the schedule's time, never the viewer's.
    expect(nextRunLabel("2026-11-29T03:30:00Z", "Asia/Kolkata", now)).toBe("Tomorrow 9:00 AM");
  });

  it("judges today and tomorrow in the schedule's zone, near midnight", () => {
    // 23:30 Sat in London is 05:00 Sun in Kolkata.
    const now = new Date("2026-11-28T23:30:00Z");
    // 9:00 Sun in Kolkata: still Sat night in London, but today on the schedule's clock.
    expect(nextRunLabel("2026-11-29T03:30:00Z", "Asia/Kolkata", now)).toBe("Today 9:00 AM");
    expect(nextRunLabel("2026-11-29T03:30:00Z", "Europe/London", now)).toBe("Tomorrow 3:30 AM");
    // 9:00 Mon in Kolkata is tomorrow there, though it's two days off on London's calendar.
    expect(nextRunLabel("2026-11-30T03:30:00Z", "Asia/Kolkata", now)).toBe("Tomorrow 9:00 AM");
    expect(nextRunLabel("2026-11-30T03:30:00Z", "Europe/London", now)).toBe("Mon 3:30 AM");
    // A year's last day rolls over to the next year's first.
    const newYearsEve = new Date("2026-12-31T20:00:00Z");
    expect(nextRunLabel("2027-01-01T08:00:00Z", "America/New_York", newYearsEve)).toBe(
      "Tomorrow 3:00 AM",
    );
    expect(todayIn("Asia/Kolkata", now)).toBe("2026-11-29");
    expect(todayIn("Europe/London", now)).toBe("2026-11-28");
  });

  it("names the schedule's zone only when it isn't the viewer's", () => {
    expect(otherZoneLabel("Asia/Kolkata", "Europe/London")).toBe("Kolkata time");
    expect(otherZoneLabel("America/New_York", "UTC")).toBe("New York time");
    expect(otherZoneLabel("UTC", "Asia/Kolkata")).toBe("UTC time");
    expect(otherZoneLabel("Asia/Kolkata", "Asia/Kolkata")).toBeNull();
    // Before the viewer's zone is known (a page rendered on the server), nothing is said.
    expect(otherZoneLabel("Asia/Kolkata", null)).toBeNull();
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

  it("finds a teammate's daily check-in by its mark, whatever it's called", () => {
    const checkIn = { teammateId: "t1", checkIn: true, enabled: true };
    expect(dailyCheckInOn([checkIn], "t1")).toBe(true);
    expect(dailyCheckInOn([checkIn], "t2")).toBe(false);
    expect(dailyCheckInOn([{ ...checkIn, enabled: false }], "t1")).toBe(false);
    // A schedule the owner named "Daily check-in" isn't the check-in.
    expect(dailyCheckInOn([{ ...checkIn, checkIn: false }], "t1")).toBe(false);
    // A server from before the mark sends none.
    expect(isDailyCheckIn({})).toBe(false);
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
