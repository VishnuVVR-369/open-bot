import { expect, it } from "vitest";
import { compactNumber, formatDuration, runClock } from "@/lib/utils";

it("formatDuration reads like a person would say it", () => {
  expect(formatDuration(400)).toBe("0s");
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(185_000)).toBe("3m 5s");
  expect(formatDuration(3_720_000)).toBe("1h 2m");
  expect(formatDuration(7_200_000)).toBe("2h");
});

it("compactNumber shortens big counts", () => {
  expect(compactNumber(950)).toBe("950");
  expect(compactNumber(18_240)).toBe("18.2K");
  expect(compactNumber(2_400_000)).toBe("2.4M");
});

it("runClock says which day a run was on, unless it was today", () => {
  const now = new Date(2026, 10, 12, 15, 0);
  expect(runClock(new Date(2026, 10, 12, 7, 30), now)).toBe("7:30 AM");
  expect(runClock(new Date(2026, 10, 11, 18, 52), now)).toBe("Yesterday 6:52 PM");
  expect(runClock(new Date(2026, 10, 9, 9, 0), now)).toBe("Mon 9:00 AM");
  expect(runClock(new Date(2026, 10, 2, 9, 0), now)).toBe("Nov 2, 9:00 AM");
  expect(runClock(new Date(2025, 11, 30, 9, 0), now)).toBe("Dec 30, 2025, 9:00 AM");
});
