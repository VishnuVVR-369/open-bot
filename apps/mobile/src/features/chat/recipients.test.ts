import { describe, expect, it } from "vitest";
import { recipients, sendMentions } from "./recipients";

const rex = { id: "rex", name: "Rex" };
const rexSmith = { id: "rex-smith", name: "Rex Smith" };
const otherRex = { id: "rex-2", name: "Rex" };

describe("whom a draft is for", () => {
  it("finds each teammate among the chat's members, by id", () => {
    expect(recipients(["rex", "gone"], [rexSmith, rex])).toEqual([
      { id: "rex", member: rex },
      { id: "gone", member: undefined },
    ]);
  });

  it("sends to the teammate it's addressed to, whatever their name", () => {
    // A name that's part of another's, a name two teammates share, a name that changed.
    expect(sendMentions("Book it", ["rex"], [rex, rexSmith], true)).toEqual(["rex"]);
    expect(sendMentions("Book it", ["rex-2"], [rex, otherRex], true)).toEqual(["rex-2"]);
    expect(sendMentions("Book it", ["rex"], [{ id: "rex", name: "Rexy" }], true)).toEqual(["rex"]);
  });

  it("adds anyone @mentioned in the text, once, and nobody in a direct chat", () => {
    expect(sendMentions("@Rex Smith too", ["rex"], [rex, rexSmith], true)).toEqual([
      "rex",
      "rex-smith",
    ]);
    expect(sendMentions("@Rex hi", ["rex"], [rex], true)).toEqual(["rex"]);
    expect(sendMentions("@Rex hi", ["rex"], [rex], false)).toEqual([]);
  });
});
