import { describe, expect, it } from "vitest";
import { IssueLog, readPageFile, violationAddress } from "./pages";

describe("violationAddress", () => {
  it("finds the address in Chromium's CSP messages", () => {
    expect(
      violationAddress(
        "Loading the script 'https://cdn.jsdelivr.net/npm/lodash/lodash.min.js' violates the following Content Security Policy directive: \"script-src 'unsafe-inline' http://127.0.0.1:7080/lib/\".",
      ),
    ).toEqual({ url: "https://cdn.jsdelivr.net/npm/lodash/lodash.min.js", connect: false });
    expect(
      violationAddress(
        "Connecting to 'https://evil.example/steal?x=1' violates the following Content Security Policy directive: \"connect-src 'none'\".",
      ),
    ).toEqual({ url: "https://evil.example/steal?x=1", connect: true });
    expect(
      violationAddress(
        "Fetch API cannot load https://api.example.com/data.json. Refused to connect because it violates the document's Content Security Policy.",
      ),
    ).toEqual({ url: "https://api.example.com/data.json", connect: true });
  });

  it("ignores everything else", () => {
    expect(violationAddress("Uncaught TypeError: x is not a function")).toBeNull();
    expect(violationAddress("violates something, but names no address")).toBeNull();
  });
});

describe("IssueLog", () => {
  it("reports each blocked address once, in words a teammate can act on", () => {
    const log = new IssueLog("127.0.0.1:7080");
    log.blocked("https://cdn.example.com/lib.js");
    log.blocked("https://cdn.example.com/lib.js#again");
    log.blocked("https://api.example.com/data", true);
    log.blocked("http://127.0.0.1:7080/lib/nope@1/x.js");
    log.blocked("http://127.0.0.1:7080/snapshot/diagram%20one.png");
    log.blocked("data:image/png;base64,AAAA");
    log.blocked("not a url");
    expect(log.issues).toEqual([
      {
        level: "error",
        message:
          "It loads https://cdn.example.com/lib.js from the internet, which pages can't reach. Use the libraries in /lib, or put it in the file.",
      },
      {
        level: "error",
        message:
          "It connects to https://api.example.com/data, but pages can't use the network. Put the data in the file.",
      },
      { level: "error", message: "There's no /lib/nope@1/x.js in the shared libraries." },
      {
        level: "error",
        message:
          "It loads diagram one.png by a relative address, which only works on the computer. Put images in the file (data: URLs or inline SVG).",
      },
    ]);
  });

  it("drops repeats and empty messages", () => {
    const log = new IssueLog("127.0.0.1:7080");
    log.add("warning", "  The page has   no title. ");
    log.add("warning", "The page has no title.");
    log.add("error", "   ");
    expect(log.issues).toEqual([{ level: "warning", message: "The page has no title." }]);
  });
});

describe("readPageFile", () => {
  it("refuses paths outside the page folders before touching the disk", async () => {
    await expect(readPageFile("/etc/passwd")).rejects.toThrow("isn't a page");
    await expect(readPageFile("/home/bot/bots/a/../../../etc/x.html")).rejects.toThrow(
      "isn't a page",
    );
    await expect(readPageFile("/home/bot/.codex/auth.html")).rejects.toThrow("isn't a page");
  });
});
