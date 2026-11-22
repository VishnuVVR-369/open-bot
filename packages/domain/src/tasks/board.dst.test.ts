import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daysUntil, dueLabel } from "./board";

// Days are the phone's or the browser's. Pin a zone whose clocks change in the range below
// (Berlin moves to summer time on 2026-03-29 and back on 2026-10-25); in UTC every day is 24 hours,
// so these would pass whatever the rounding.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  process.env.TZ = zone;
});

describe("due days across a clock change", () => {
  it("runs in a zone with clock changes", () => {
    expect(new Date(2026, 2, 20).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 3, 5).getTimezoneOffset()).toBe(-120);
  });

  it("counts a 23-hour day as one", () => {
    expect(daysUntil("2026-04-05", new Date(2026, 2, 20, 12))).toBe(16);
    expect(daysUntil("2026-03-30", new Date(2026, 2, 29, 0, 30))).toBe(1);
    expect(dueLabel("2026-03-30", new Date(2026, 2, 29, 12))).toBe("Tomorrow");
  });

  it("counts a 25-hour day as one", () => {
    expect(daysUntil("2026-10-26", new Date(2026, 9, 25, 12))).toBe(1);
    expect(daysUntil("2026-10-24", new Date(2026, 9, 26, 12))).toBe(-2);
    expect(dueLabel("2026-10-24", new Date(2026, 9, 25, 12))).toBe("Yesterday");
  });
});
