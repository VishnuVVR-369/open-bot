import { describe, expect, it } from "vitest";
import {
  excerptLine,
  highlightParts,
  matchScore,
  preferWordStarts,
  queryWords,
  rankFound,
  startsWords,
} from "./search-match";

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

describe("preferWordStarts", () => {
  it("drops matches inside words when a word-start match exists", () => {
    const titles = ["Kestrel launch checklist", "Lisbon trip itinerary"];
    expect(preferWordStarts(titles, (t) => t, ["lis"])).toEqual(["Lisbon trip itinerary"]);
  });

  it("keeps matches inside words when there is nothing better", () => {
    expect(preferWordStarts(["Kestrel launch checklist"], (t) => t, ["lis"])).toEqual([
      "Kestrel launch checklist",
    ]);
  });
});

describe("excerptLine", () => {
  it("drops a half word at a cut start", () => {
    expect(excerptLine("…efund of $228, and the email list", ["list"])).toBe(
      "…of $228, and the email list",
    );
  });

  it("starts shortly before a match far into the text", () => {
    const text = `${"word ".repeat(30)}the email list for your OK`;
    const line = excerptLine(text, ["list"]);
    expect(line.startsWith("…")).toBe(true);
    expect(line.endsWith("list for your OK")).toBe(true);
    expect(line.length).toBeLessThan(60);
  });

  it("starts at a sentence before the match rather than mid-sentence", () => {
    expect(
      excerptLine("…efund of $228, and says when it will land. It is waiting in the email list", [
        "list",
      ]),
    ).toBe("It is waiting in the email list");
  });

  it("leaves a short text alone", () => {
    expect(excerptLine("Book the TAP nonstop for Lisbon.", ["lis"])).toBe(
      "Book the TAP nonstop for Lisbon.",
    );
  });
});

describe("rankFound", () => {
  const title = (text: string) => text;
  it("drops a title with the word only inside another word", () => {
    expect(
      rankFound(["Kestrel launch checklist", "Lisbon trip itinerary"], title, ["lis"]),
    ).toEqual(["Lisbon trip itinerary"]);
  });

  it("keeps results that matched elsewhere, after title matches", () => {
    expect(rankFound(["Cache notes", "Evict the rest"], title, ["evict"])).toEqual([
      "Evict the rest",
      "Cache notes",
    ]);
  });
});
