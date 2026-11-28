import { describe, expect, it } from "vitest";
import {
  copyName,
  lastGlyph,
  lastGlyphByPattern,
  newTeammateSlot,
  nextTeammateColor,
  TEAMMATE_COLORS,
} from "./profile";

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

describe("a copy's name", () => {
  it("takes the next number nobody uses", () => {
    expect(copyName("Iris", ["Iris"])).toBe("Iris 2");
    expect(copyName("Iris", ["Iris", "iris 2", "Iris 3"])).toBe("Iris 4");
    expect(copyName("Iris 2", ["Iris", "Iris 2"])).toBe("Iris 3");
    expect(copyName("  Iris ", ["Iris"])).toBe("Iris 2");
  });
});

describe("the last character typed", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["a", "a"],
    ["ab", "b"],
    ["🦊", "🦊"],
    ["🦊🐙", "🐙"],
    ["x👍🏽", "👍🏽"],
    ["🇮🇳", "🇮🇳"],
    ["a🇬🇧🇮🇳", "🇮🇳"],
    ["👩‍💻", "👩‍💻"],
    ["🦊👨‍👩‍👧", "👨‍👩‍👧"],
    ["❤️", "❤️"],
    ["1️⃣", "1️⃣"],
    ["🏴󠁧󠁢󠁳󠁣󠁴󠁿", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"],
    ["x👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"],
    ["🧑🏽‍🤝‍🧑🏿", "🧑🏽‍🤝‍🧑🏿"],
    ["👩🏻‍❤️‍💋‍👨🏼", "👩🏻‍❤️‍💋‍👨🏼"],
    ["é", "é"],
    ["ae\u0301", "e\u0301"],
  ];

  it.each(cases)("of %j is %j, whole", (text, glyph) => {
    expect(lastGlyph(text)).toBe(glyph);
  });

  it.each(cases)("of %j is %j without Intl.Segmenter too", (text, glyph) => {
    expect(lastGlyphByPattern(text)).toBe(glyph);
  });
});
