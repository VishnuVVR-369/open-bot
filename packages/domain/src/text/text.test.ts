import { describe, expect, it } from "vitest";
import { chatTitleText, compactNumber, formatDuration, plainText, speakable } from "./text";

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

describe("chat titles", () => {
  it("tidies what a teammate gives", () => {
    expect(chatTitleText("  Fix the login redirect  ")).toBe("Fix the login redirect");
    expect(chatTitleText('"Lisbon trip ideas."')).toBe("Lisbon trip ideas");
    expect(chatTitleText("“Quarterly **report**”")).toBe("Quarterly report");
    expect(chatTitleText("Two\nlines")).toBe("Two lines");
    expect(chatTitleText(" ... ")).toBe("");
  });

  it("cuts long titles on a word", () => {
    const long = "Compare the three apartment listings near the river and pick the best one";
    const title = chatTitleText(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(title)).toBe(true);
    expect(long[title.length]).toBe(" ");
  });
});
