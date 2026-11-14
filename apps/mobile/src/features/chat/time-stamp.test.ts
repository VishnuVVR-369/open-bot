import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeStamp } from "./time-stamp";

vi.mock("expo-localization", () => ({ getCalendars: () => [{ uses24hourClock: true }] }));

/** A local time on a day relative to "now", which is 2026-11-13 15:00 local. */
const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 10, day, hours, minutes).toISOString();

describe("timeStamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 13, 15, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("stamps the first entry, and one after a pause of an hour or more", () => {
    expect(timeStamp(at(13, 9), undefined)).toMatch(/^Today 09:00$/);
    expect(timeStamp(at(13, 10, 30), at(13, 9, 15))).toMatch(/^Today 10:30$/);
  });

  it("leaves an entry that follows soon after on the same day unstamped", () => {
    expect(timeStamp(at(13, 10, 30), at(13, 10))).toBeNull();
  });

  it("stamps a new day even when the gap is short", () => {
    expect(timeStamp(at(13, 0, 10), at(12, 23, 50))).toMatch(/^Today 00:10$/);
  });

  it("says yesterday, then the date, with the year only when it isn't this one", () => {
    expect(timeStamp(at(12, 21, 5), undefined)).toMatch(/^Yesterday 21:05$/);
    expect(timeStamp(at(2, 22, 29), undefined)).toMatch(/^Mon 2 Nov, 22:29$/);
    expect(timeStamp(new Date(2025, 10, 2, 9).toISOString(), undefined)).toMatch(
      /^Sun,? 2 Nov 2025, 09:00$/,
    );
  });
});
