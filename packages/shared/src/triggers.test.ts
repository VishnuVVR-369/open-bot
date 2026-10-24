import { describe, expect, it } from "vitest";
import {
  describeInterval,
  describeWatchChange,
  diffLines,
  invalidWatchUrl,
  isPrivateAddress,
  pageText,
  summarizeWatchChange,
  watchChange,
} from "./triggers";

describe("page text", () => {
  it("keeps the readable text, one block per line", () => {
    const html = `<!doctype html><html><head><title>Shop</title><style>p{color:red}</style>
      <script>var price = 10;</script></head>
      <body><h1>Blue  kettle</h1><p>Price: &pound;24.99 &amp; free&nbsp;delivery</p>
      <!-- hidden --><ul><li>In stock</li><li>Ships <b>today</b></li></ul></body></html>`;
    expect(pageText(html)).toBe(
      "Shop\nBlue kettle\nPrice: £24.99 & free delivery\nIn stock\nShips today",
    );
  });

  it("leaves plain text and JSON as they are", () => {
    expect(pageText('{"price": 10}', "application/json")).toBe('{"price": 10}');
    expect(pageText("a\n\n  b  \n", "text/plain")).toBe("a\nb");
  });

  it("decodes numeric entities", () => {
    expect(pageText("<p>&#8364;5 &#x2713;</p>")).toBe("€5 ✓");
  });
});

describe("diffing pages", () => {
  it("finds added and removed lines, ignoring order", () => {
    expect(diffLines("a\nb\nc", "c\nb\nd")).toEqual({ added: ["d"], removed: ["a"] });
    expect(diffLines("a\na", "a")).toEqual({ added: [], removed: ["a"] });
  });

  it("learns the page on the first check", () => {
    expect(watchChange(null, "anything", null)).toBeNull();
  });

  it("fires on any change, or none", () => {
    expect(watchChange("Price: 10", "Price: 10", null)).toBeNull();
    expect(watchChange("Price: 10", "Price: 8", null)).toEqual({
      added: ["Price: 8"],
      removed: ["Price: 10"],
    });
  });

  it("fires once when the text it looks for appears", () => {
    expect(watchChange("Sold out", "In stock now", "in stock")).toMatchObject({
      found: "In stock now",
    });
    expect(watchChange("In stock now", "In stock, 2 left", "in stock")).toBeNull();
    expect(watchChange("Sold out", "Sold out soon", "in stock")).toBeNull();
  });

  it("describes a change for the bot and the app", () => {
    const change = { added: ["Price: 8"], removed: ["Price: 10"] };
    expect(describeWatchChange(change)).toBe(
      "New on the page:\n  Price: 8\n\nNo longer on the page:\n  Price: 10",
    );
    expect(summarizeWatchChange(change)).toBe("1 new line, 1 removed line");
    expect(summarizeWatchChange({ added: [], removed: [], found: "In stock" })).toBe(
      "“In stock” appeared",
    );
  });

  it("clips long changes", () => {
    const added = Array.from({ length: 45 }, (_, i) => `line ${i}`);
    expect(describeWatchChange({ added, removed: [] })).toContain("(5 more lines)");
  });
});

describe("watch addresses", () => {
  it("accepts web pages only", () => {
    expect(invalidWatchUrl("https://example.com/item")).toBeNull();
    expect(invalidWatchUrl("example.com")).toMatch(/full web address/);
    expect(invalidWatchUrl("file:///etc/passwd")).toMatch(/http/);
    expect(invalidWatchUrl("https://me:pw@example.com")).toMatch(/sign-in/);
  });

  it("knows private network addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.2.3.4",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("describes intervals", () => {
    expect(describeInterval(60)).toBe("Every hour");
    expect(describeInterval(120)).toBe("Every 2 hours");
    expect(describeInterval(2880)).toBe("Every 2 days");
    expect(describeInterval(30)).toBe("Every 30 minutes");
  });
});
