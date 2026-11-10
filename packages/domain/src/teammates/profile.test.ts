import { describe, expect, it } from "vitest";
import { newTeammateSlot } from "./profile";

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
