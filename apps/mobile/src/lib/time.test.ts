import { describe, expect, it } from "vitest";
import { ago, clock, dayClock, elapsed } from "./time";

describe("times in lists", () => {
  const now = new Date(2026, 10, 2, 15, 0, 0).getTime();
  const at = (...args: [number, number, number, number?, number?]) =>
    new Date(...(args as [number, number, number, number, number])).toISOString();

  it("reads like the web's", () => {
    expect(ago(new Date(now - 30_000).toISOString(), now)).toBe("now");
    expect(ago(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
    expect(ago(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3h");
    expect(ago(at(2026, 10, 1, 23, 0), now)).toBe("Yesterday");
    expect(ago(at(2026, 9, 12, 9, 0), now)).toBe("12 Oct");
    expect(ago(at(2025, 9, 12, 9, 0), now)).toBe("12 Oct 2025");
  });

  it("follows the phone's clock setting", () => {
    expect(clock(at(2026, 10, 2, 17, 5))).toBe("17:05");
    expect(clock(at(2026, 10, 2, 17, 5), true)).toBe("5:05 PM");
    expect(clock(at(2026, 10, 2, 0, 30), true)).toBe("12:30 AM");
    expect(clock(at(2026, 10, 2, 12, 0), true)).toBe("12:00 PM");
    expect(clock(at(2026, 10, 2, 9, 0))).toBe("09:00");
  });

  it("adds the day to times before today", () => {
    expect(dayClock(at(2026, 10, 2, 9, 5), false, now)).toBe("09:05");
    expect(dayClock(at(2026, 10, 1, 21, 0), true, now)).toBe("Sun 9:00 PM");
  });

  it("counts running time", () => {
    expect(elapsed(42_000)).toBe("42s");
    expect(elapsed(185_000)).toBe("3m 05s");
  });
});
