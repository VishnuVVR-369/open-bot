import { describe, expect, it } from "vitest";
import { splitComputerPaths } from "./files";

describe("splitComputerPaths", () => {
  it("finds files on the computer, without trailing punctuation", () => {
    expect(splitComputerPaths("Saved to /home/bot/shared/report.md. Also /home/bot/x/")).toEqual([
      { text: "Saved to ", path: false },
      { text: "/home/bot/shared/report.md", path: true },
      { text: ". Also /home/bot/x/", path: false },
    ]);
  });
  it("leaves text without paths alone", () => {
    expect(splitComputerPaths("nothing here")).toEqual([{ text: "nothing here", path: false }]);
  });
});
