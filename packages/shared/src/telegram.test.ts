import { describe, expect, it } from "vitest";
import { newLinkCode, splitTelegram, telegramHtml } from "./telegram";

describe("telegram formatting", () => {
  it("turns Markdown into Telegram HTML", () => {
    expect(
      telegramHtml("**Done.** See `notes.md` and [the doc](https://example.com/a?b=1&c=2)."),
    ).toBe(
      '<b>Done.</b> See <code>notes.md</code> and <a href="https://example.com/a?b=1&amp;c=2">the doc</a>.',
    );
  });

  it("escapes HTML so text can't break the message", () => {
    expect(telegramHtml("1 < 2 & 3 > 2 <b>not bold</b>")).toBe(
      "1 &lt; 2 &amp; 3 &gt; 2 &lt;b&gt;not bold&lt;/b&gt;",
    );
  });

  it("keeps code blocks as they are", () => {
    expect(telegramHtml("Run:\n```sh\necho **hi** <x>\n```\nok")).toBe(
      "Run:\n<pre>echo **hi** &lt;x&gt;</pre>\nok",
    );
  });

  it("formats headings, lists, quotes and rules", () => {
    expect(telegramHtml("## Today\n- one\n* two\n> quoted\n> more\n---\nend")).toBe(
      "<b>Today</b>\n• one\n• two\n<blockquote>quoted\nmore</blockquote>\n──────\nend",
    );
  });

  it("leaves underscores and stars inside words alone", () => {
    expect(telegramHtml("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
    expect(telegramHtml("an _italic_ word and *this*")).toBe(
      "an <i>italic</i> word and <i>this</i>",
    );
  });
});

describe("splitting long messages", () => {
  it("keeps short text whole", () => {
    expect(splitTelegram("hello", 10)).toEqual(["hello"]);
  });

  it("splits at paragraph breaks first", () => {
    expect(splitTelegram("aaaa aaaa\n\nbbbb bbbb", 12)).toEqual(["aaaa aaaa", "bbbb bbbb"]);
  });

  it("never cuts inside a tag", () => {
    const chunks = splitTelegram(`${"x".repeat(8)}<b>yy</b>`, 10);
    expect(chunks[0]).toBe("x".repeat(8));
    expect(chunks.join("")).toBe(`${"x".repeat(8)}<b>yy</b>`);
  });
});

describe("link codes", () => {
  it("uses unambiguous characters", () => {
    const code = newLinkCode((size) => Uint8Array.from({ length: size }, (_, i) => i * 37));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});
