import { describe, expect, it } from "vitest";
import { insertMention, mentionedIds, mentionOptions, mentionQuery } from "./mentions";

const members = [
  { id: "1", name: "Rex" },
  { id: "2", name: "Iris" },
  { id: "3", name: "C++" },
  { id: "4", name: "a(b" },
  { id: "5", name: "Mira" },
];

describe("mentionedIds", () => {
  it("reads who a message is for", () => {
    expect(mentionedIds("@rex and @Iris, please", members)).toEqual(["1", "2"]);
    expect(mentionedIds("email rex@x.com", members)).toEqual([]);
    expect(mentionedIds("@Rexford, hi", members)).toEqual([]);
  });

  it("takes names with symbols literally, anywhere in the message", () => {
    expect(mentionedIds("@C++ can you look at the build?", members)).toEqual(["3"]);
    expect(mentionedIds("thanks @a(b", members)).toEqual(["4"]);
    expect(mentionedIds("@C can you look?", members)).toEqual([]);
  });
});

describe("the @ menu", () => {
  it("notices an @ being typed at the caret", () => {
    expect(mentionQuery("Hi @Re", 6)).toBe("Re");
    expect(mentionQuery("@", 1)).toBe("");
    expect(mentionQuery("mail me@home", 12)).toBeNull();
    expect(mentionQuery("Hi @Rex and", 11)).toBeNull();
  });

  it("offers names that start with it first, then those that contain it", () => {
    expect(mentionOptions(members, "ir").map((m) => m.name)).toEqual(["Iris", "Mira"]);
    expect(mentionOptions(members, "")).toHaveLength(5);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, name: `Ana ${i}` }));
    expect(mentionOptions(many, "an")).toHaveLength(6);
  });

  it("completes the name and moves the caret after it", () => {
    expect(insertMention("Ask @ir about it", 7, members[1]!)).toEqual({
      text: "Ask @Iris about it",
      caret: 10,
    });
    expect(insertMention("@R", 2, members[0]!)).toEqual({ text: "@Rex ", caret: 5 });
  });

  it("inserts a name with replacement patterns as written", () => {
    expect(insertMention("@x", 2, { id: "6", name: "A$&B" })).toEqual({
      text: "@A$&B ",
      caret: 6,
    });
  });
});
