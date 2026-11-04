import { describe, expect, it } from "vitest";
import { splitComputerPaths } from "./files";
import { compactNumber, formatDuration, plainText, speakable } from "./text";

describe("text", () => {
  it("flattens Markdown for previews", () => {
    expect(plainText("## Done\n- **Booked** the [flight](https://x.y)\n- `seat` 4A")).toBe(
      "Done Booked the flight seat 4A",
    );
  });
  it("keeps a code block's text without its fences", () => {
    expect(plainText("Output:\n```text\n/home/bot/bots/iris\n```")).toBe(
      "Output: /home/bot/bots/iris",
    );
    expect(plainText("~~~\nls\n~~~")).toBe("ls");
  });
  it("reads lists with pauses", () => {
    expect(speakable("Two things\n- milk\n- eggs!")).toBe("Two things. milk. eggs!");
    expect(speakable("Here:\n```sh\npwd\n```")).toBe("Here: pwd.");
  });
  it("formats sizes and durations", () => {
    expect(compactNumber(18_200)).toBe("18.2K");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});

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
