import { expect, it } from "vitest";
import { compactNumber, formatDuration } from "@/lib/utils";

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
