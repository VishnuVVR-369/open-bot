import type { RunView } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import { completedRepliesKey } from "./read-marker";

function runs(first: number, last: number) {
  return Object.fromEntries(
    Array.from({ length: last - first + 1 }, (_, index) => {
      const id = `r${first + index}`;
      return [
        id,
        { id, completedAt: "2026-11-03T00:00:00Z", timeline: { status: "completed" } } as RunView,
      ];
    }),
  );
}

describe("read marker dependencies", () => {
  it("changes when a bounded page replaces completed replies, even at the same timestamp", () => {
    expect(completedRepliesKey(runs(1, 30))).not.toBe(completedRepliesKey(runs(2, 31)));
  });

  it("is stable across ordering changes and ignores streaming deltas", () => {
    const before = runs(1, 30);
    expect(completedRepliesKey(before)).toBe(
      completedRepliesKey(Object.fromEntries(Object.entries(before).reverse())),
    );
    const active = {
      id: "active",
      completedAt: null,
      timeline: { status: "running", items: [] },
    } as unknown as RunView;
    expect(completedRepliesKey({ ...before, active })).toBe(completedRepliesKey(before));
  });
});
