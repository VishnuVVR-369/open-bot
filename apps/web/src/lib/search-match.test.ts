import { describe, expect, it } from "vitest";
import { highlightParts, matchScore, queryWords, startsWords } from "./search-match";

describe("matchScore", () => {
  it("matches words where they start", () => {
    expect(matchScore(["Lisbon trip"], ["lis"])).toBe(3);
    expect(matchScore(["Kestrel launch checklist"], ["lis"])).toBeNull();
    expect(matchScore(["Publish the post"], ["lis"])).toBeNull();
  });

  it("ranks a title match above a match elsewhere", () => {
    expect(matchScore(["Iris", "Chief of staff"], ["chief"])).toBe(1);
    expect(matchScore(["Book the Lisbon flights"], ["lis"])).toBe(2);
    expect(matchScore(["Anything"], [])).toBe(0);
  });

  it("needs every word", () => {
    expect(matchScore(["Lisbon trip", "Iris, Scout"], queryWords("trip scout"))).toBe(1);
    expect(matchScore(["Lisbon trip"], queryWords("trip kit"))).toBeNull();
  });
});

describe("highlightParts", () => {
  const marked = (text: string, query: string) =>
    highlightParts(text, queryWords(query))
      .filter((part) => part.mark)
      .map((part) => part.text);

  it("marks word starts only", () => {
    expect(marked("Publish to Lisbon, the list", "lis")).toEqual(["Lis", "lis"]);
  });

  it("falls back to a match inside a word", () => {
    expect(marked("Kestrel launch checklist", "lis")).toEqual(["lis"]);
  });

  it("marks each word and merges overlaps", () => {
    expect(marked("Lisbon trip itinerary", "trip lisbon")).toEqual(["Lisbon", "trip"]);
    expect(highlightParts("Lisbon", ["li", "lis"])).toEqual([
      { text: "Lis", mark: true },
      { text: "bon", mark: false },
    ]);
  });
});

describe("startsWords", () => {
  it("is true only when every word starts a word", () => {
    expect(startsWords("Book the Lisbon flights", ["lis", "fli"])).toBe(true);
    expect(startsWords("Publish it", ["lis"])).toBe(false);
  });
});
