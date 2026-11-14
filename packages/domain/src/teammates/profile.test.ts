import { describe, expect, it } from "vitest";
import { TEAMMATE_COLORS, newTeammateSlot, nextTeammateColor } from "./profile";

describe("a new teammate's place on the team", () => {
  it("takes the next free slug, archived teammates' included", () => {
    const team = [
      { slug: "scout", archivedAt: null },
      { slug: "scout-2", archivedAt: new Date() },
    ];
    expect(newTeammateSlot(team, "Scout")).toEqual({ slug: "scout-3", first: false });
    expect(newTeammateSlot(team, "Iris")).toEqual({ slug: "iris", first: false });
  });

  it("leads when nobody else is on the team", () => {
    expect(newTeammateSlot([], "Iris")).toEqual({ slug: "iris", first: true });
    expect(newTeammateSlot([{ slug: "old", archivedAt: new Date() }], "Iris").first).toBe(true);
  });
});

describe("a new teammate's color", () => {
  it("is the first color nobody uses, then the least used", () => {
    expect(nextTeammateColor([])).toBe(TEAMMATE_COLORS[0]);
    expect(nextTeammateColor([TEAMMATE_COLORS[0], TEAMMATE_COLORS[2]])).toBe(TEAMMATE_COLORS[1]);
    const everyColorOnce = [...TEAMMATE_COLORS];
    expect(nextTeammateColor([...everyColorOnce, TEAMMATE_COLORS[0]])).toBe(TEAMMATE_COLORS[1]);
    expect(nextTeammateColor(["#000000"])).toBe(TEAMMATE_COLORS[0]);
  });
});
