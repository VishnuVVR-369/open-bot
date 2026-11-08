import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

describe("relativeTime", () => {
  // Thu Nov 12 2026, 15:00 local time.
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  const at = (...parts: [number, number, number, number?, number?]) =>
    new Date(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0);

  it.each([
    [at(2026, 10, 12, 14, 59), "1m ago"],
    [at(2026, 10, 12, 14, 30), "30m ago"],
    [at(2026, 10, 12, 11, 0), "4h ago"],
    [at(2026, 10, 11, 23, 0), "yesterday"],
    [at(2026, 10, 9, 10, 0), "Mon"],
    [at(2026, 9, 12, 10, 0), "Oct 12"],
    [at(2025, 9, 12, 10, 0), "Oct 12, 2025"],
  ])("%s", (date, expected) => {
    expect(relativeTime(date, now)).toBe(expected);
  });

  it("says just now for the last minute and for clock skew", () => {
    expect(relativeTime(new Date(now - 20_000), now)).toBe("just now");
    expect(relativeTime(new Date(now + 5_000), now)).toBe("just now");
  });
});
