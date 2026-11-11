import { describe, expect, it } from "vitest";
import { BOT_COLORS, newTeammateSlot, nextTeammateColor } from "./profile";

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
    expect(nextTeammateColor([])).toBe(BOT_COLORS[0]);
    expect(nextTeammateColor([BOT_COLORS[0], BOT_COLORS[2]])).toBe(BOT_COLORS[1]);
    const everyColorOnce = [...BOT_COLORS];
    expect(nextTeammateColor([...everyColorOnce, BOT_COLORS[0]])).toBe(BOT_COLORS[1]);
    expect(nextTeammateColor(["#000000"])).toBe(BOT_COLORS[0]);
  });
});
