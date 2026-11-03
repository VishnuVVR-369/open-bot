import { describe, expect, it } from "vitest";
import { insertMention, mentionedIds, mentionOptions, mentionQuery } from "./mentions";

const members = [
  { id: "1", name: "Rex" },
  { id: "2", name: "Iris" },
  { id: "3", name: "Mira" },
];

describe("mentions", () => {
  it("notices an @ being typed at the caret", () => {
    expect(mentionQuery("Hi @Re", 6)).toBe("Re");
    expect(mentionQuery("@", 1)).toBe("");
    expect(mentionQuery("mail me@home", 12)).toBeNull();
    expect(mentionQuery("Hi @Rex and", 11)).toBeNull();
  });

  it("offers names that start with it first", () => {
    expect(mentionOptions(members, "ir").map((m) => m.name)).toEqual(["Iris", "Mira"]);
    expect(mentionOptions(members, "")).toHaveLength(3);
  });

  it("completes the name and moves the caret after it", () => {
    expect(insertMention("Ask @ir about it", 7, members[1]!)).toEqual({
      text: "Ask @Iris about it",
      caret: 10,
    });
    expect(insertMention("@R", 2, members[0]!)).toEqual({ text: "@Rex ", caret: 5 });
  });

  it("reads who a message is for", () => {
    expect(mentionedIds("@rex and @Iris, please", members)).toEqual(["1", "2"]);
    expect(mentionedIds("email rex@x.com", members)).toEqual([]);
  });
});
