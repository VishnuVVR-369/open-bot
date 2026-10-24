import { describe, expect, it } from "vitest";
import { COMPUTER_FILE_PATH, fileKind, fileUrl } from "@/lib/files";
import { remarkFileLinks } from "@/lib/remark-file-links";

describe("fileKind", () => {
  it("knows what it can show", () => {
    expect(fileKind("photo.JPG")).toBe("image");
    expect(fileKind("report.pdf")).toBe("pdf");
    expect(fileKind("notes.md")).toBe("markdown");
    expect(fileKind("prices.tsv")).toBe("csv");
    expect(fileKind("main.py")).toBe("text");
    expect(fileKind("archive.zip")).toBe("other");
    expect(fileKind("Makefile")).toBe("other");
  });
});

it("fileUrl encodes the path", () => {
  expect(fileUrl("/home/bot/shared/a b.md")).toBe(
    "/api/files/download?path=%2Fhome%2Fbot%2Fshared%2Fa%20b.md",
  );
  expect(fileUrl("/home/bot/x.png", true)).toMatch(/^\/api\/files\/download\?inline=1&path=/);
});

describe("COMPUTER_FILE_PATH", () => {
  const paths = (text: string) => [...text.matchAll(COMPUTER_FILE_PATH)].map((m) => m[0]);

  it("finds files and leaves punctuation and folders out", () => {
    expect(paths("Saved to /home/bot/shared/report.md.")).toEqual(["/home/bot/shared/report.md"]);
    expect(paths("See /home/bot/bots/rex/out/data.v2.csv, and /home/bot/shared/x.png!")).toEqual([
      "/home/bot/bots/rex/out/data.v2.csv",
      "/home/bot/shared/x.png",
    ]);
    expect(paths("(/home/bot/shared/a.txt)")).toEqual(["/home/bot/shared/a.txt"]);
    expect(paths("The folder /home/bot/shared/ is empty.")).toEqual([]);
    expect(paths("/etc/passwd.txt")).toEqual([]);
  });
});

describe("remarkFileLinks", () => {
  const run = (tree: object) => {
    remarkFileLinks()(tree as never);
    return tree;
  };

  it("turns paths in text into links", () => {
    const tree = run({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Wrote /home/bot/shared/a.md for you." }],
        },
      ],
    });
    expect(tree).toEqual({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Wrote " },
            {
              type: "link",
              url: "/home/bot/shared/a.md",
              children: [{ type: "text", value: "/home/bot/shared/a.md" }],
            },
            { type: "text", value: " for you." },
          ],
        },
      ],
    });
  });

  it("turns code that is only a path into a link, and leaves other code alone", () => {
    const tree = run({
      type: "paragraph",
      children: [
        { type: "inlineCode", value: "/home/bot/shared/a.csv" },
        { type: "inlineCode", value: "cat /home/bot/shared/a.csv" },
      ],
    });
    expect(tree).toMatchObject({
      children: [
        { type: "link", url: "/home/bot/shared/a.csv" },
        { type: "inlineCode", value: "cat /home/bot/shared/a.csv" },
      ],
    });
  });

  it("leaves code blocks and existing links alone", () => {
    const code = { type: "code", value: "/home/bot/shared/a.md" };
    const link = {
      type: "link",
      url: "https://example.com",
      children: [{ type: "text", value: "/home/bot/shared/a.md" }],
    };
    const tree = run({ type: "root", children: [code, { type: "paragraph", children: [link] }] });
    expect(tree).toEqual({
      type: "root",
      children: [code, { type: "paragraph", children: [link] }],
    });
  });
});
