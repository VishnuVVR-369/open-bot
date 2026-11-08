import { describe, expect, it } from "vitest";
import { mentionedIds } from "./mentions";

const members = [
  { id: "1", name: "Rex" },
  { id: "2", name: "Iris" },
  { id: "3", name: "C++" },
  { id: "4", name: "a(b" },
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
