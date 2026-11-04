import { describe, expect, it } from "vitest";
import { dayGroup, groupByDay, recently } from "./day-groups";

describe("day groups", () => {
  // Wednesday 4 Nov 2026, 15:00.
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  const at = (day: number, hour = 9) => new Date(2026, 10, day, hour, 0).toISOString();

  it("buckets by calendar day, not by hours ago", () => {
    expect(dayGroup(at(4, 0), now)).toBe("Today");
    expect(dayGroup(at(3, 23), now)).toBe("Yesterday");
    expect(dayGroup(at(3, 0), now)).toBe("Yesterday");
    expect(dayGroup(at(2, 23), now)).toBe("Earlier");
  });

  it("keeps the last week apart when asked", () => {
    expect(dayGroup(at(2), now, true)).toBe("Earlier this week");
    expect(dayGroup(new Date(2026, 9, 28, 23).toISOString(), now, true)).toBe("Older");
    expect(dayGroup(new Date(2026, 9, 29, 0).toISOString(), now, true)).toBe("Earlier this week");
  });

  it("groups a newest-first list in order", () => {
    const items = [at(4, 12), at(4, 8), at(3), at(1), new Date(2026, 8, 1).toISOString()];
    expect(
      groupByDay(items, (iso) => iso, { now, week: true }).map((group) => [
        group.title,
        group.data.length,
      ]),
    ).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Earlier this week", 1],
      ["Older", 1],
    ]);
  });

  it("says how long ago, for earlier today", () => {
    expect(recently(new Date(now - 20_000).toISOString(), now)).toBe("just now");
    expect(recently(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(recently(at(4, 11), now)).toBe("4h ago");
    expect(recently(at(3, 23), now)).toBeNull();
  });
});
