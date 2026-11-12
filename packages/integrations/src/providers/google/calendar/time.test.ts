import { describe, expect, it } from "vitest";
import { freeTime, isoInZone, mergeIntervals, zonedTime, zoneOffset } from "./time";

const at = (iso: string) => new Date(iso);
const span = (start: string, end: string) => ({ start: at(start), end: at(end) });
const iso = (intervals: { start: Date; end: Date }[]) =>
  intervals.map((entry) => [entry.start.toISOString(), entry.end.toISOString()]);

describe("time zones", () => {
  it("knows a zone's offset, across daylight saving", () => {
    expect(zoneOffset(at("2026-01-15T12:00:00Z"), "Europe/Berlin")).toBe(60 * 60_000);
    expect(zoneOffset(at("2026-07-15T12:00:00Z"), "Europe/Berlin")).toBe(2 * 60 * 60_000);
    expect(zoneOffset(at("2026-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(330 * 60_000);
  });

  it("finds the moment of a wall-clock time, on the day the clocks change", () => {
    // Berlin moves to summer time at 02:00 on 29 March 2026.
    expect(
      zonedTime({ year: 2026, month: 3, day: 29 }, "09:00", "Europe/Berlin").toISOString(),
    ).toBe("2026-03-29T07:00:00.000Z");
    expect(
      zonedTime({ year: 2026, month: 3, day: 28 }, "09:00", "Europe/Berlin").toISOString(),
    ).toBe("2026-03-28T08:00:00.000Z");
  });

  it("writes RFC 3339 with the zone's offset", () => {
    expect(isoInZone(at("2026-11-06T09:00:00Z"), "Europe/Berlin")).toBe(
      "2026-11-06T10:00:00+01:00",
    );
    expect(isoInZone(at("2026-11-06T09:00:00Z"), "America/New_York")).toBe(
      "2026-11-06T04:00:00-05:00",
    );
  });
});

describe("busy blocks", () => {
  it("merges overlapping and touching blocks, and drops empty ones", () => {
    expect(
      iso(
        mergeIntervals([
          span("2026-11-06T11:00:00Z", "2026-11-06T12:00:00Z"),
          span("2026-11-06T09:00:00Z", "2026-11-06T10:00:00Z"),
          span("2026-11-06T09:30:00Z", "2026-11-06T11:00:00Z"),
          span("2026-11-06T13:00:00Z", "2026-11-06T13:00:00Z"),
        ]),
      ),
    ).toEqual([["2026-11-06T09:00:00.000Z", "2026-11-06T12:00:00.000Z"]]);
  });
});

describe("free time", () => {
  const base = {
    timeZone: "UTC",
    hours: null,
    max: 10,
  };

  it("finds gaps long enough between busy blocks", () => {
    expect(
      iso(
        freeTime({
          ...base,
          from: at("2026-11-06T09:00:00Z"),
          to: at("2026-11-06T12:00:00Z"),
          minutes: 30,
          busy: [
            span("2026-11-06T09:15:00Z", "2026-11-06T10:00:00Z"),
            span("2026-11-06T10:20:00Z", "2026-11-06T11:00:00Z"),
          ],
        }),
      ),
    ).toEqual([["2026-11-06T11:00:00.000Z", "2026-11-06T12:00:00.000Z"]]);
  });

  it("keeps to working hours and days in the zone", () => {
    const free = freeTime({
      ...base,
      timeZone: "Europe/Berlin",
      // Friday 6 to Monday 9 November.
      from: at("2026-11-06T00:00:00Z"),
      to: at("2026-11-09T23:00:00Z"),
      minutes: 60,
      hours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
      busy: [span("2026-11-06T08:00:00Z", "2026-11-06T12:00:00Z")],
    });
    expect(iso(free)).toEqual([
      ["2026-11-06T12:00:00.000Z", "2026-11-06T16:00:00.000Z"],
      ["2026-11-09T08:00:00.000Z", "2026-11-09T16:00:00.000Z"],
    ]);
  });

  it("returns at most max, earliest first, and nothing for an empty range", () => {
    const free = freeTime({
      ...base,
      from: at("2026-11-06T00:00:00Z"),
      to: at("2026-11-06T06:00:00Z"),
      minutes: 30,
      max: 2,
      busy: [
        span("2026-11-06T01:00:00Z", "2026-11-06T02:00:00Z"),
        span("2026-11-06T03:00:00Z", "2026-11-06T04:00:00Z"),
      ],
    });
    expect(free).toHaveLength(2);
    expect(free[0]!.start.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(
      freeTime({
        ...base,
        from: at("2026-11-06T06:00:00Z"),
        to: at("2026-11-06T05:00:00Z"),
        minutes: 30,
        busy: [],
      }),
    ).toEqual([]);
  });
});
