import { describe, expect, it } from "vitest";
import {
  injectPageRuntime,
  isPageSourcePath,
  MAX_PAGE_QUOTE,
  pageContentSecurityPolicy,
  pageQuestionText,
  pageViewQuery,
  parsePageAskMessage,
} from "./pages";

const runtime = "https://pages.example.app/lib/runtime.js";
const tag = `<script src="${runtime}"></script>`;

describe("pageContentSecurityPolicy", () => {
  const csp = pageContentSecurityPolicy("https://pages.example.app/", ["https://app.example.app"]);

  it("sandboxes the page without its own origin, and without the network", () => {
    expect(csp).toMatch(/^sandbox allow-scripts /);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("loads code only from the page and the shared libraries", () => {
    expect(csp).toContain("script-src 'unsafe-inline' https://pages.example.app/lib/;");
    expect(csp).not.toMatch(/script-src[^;]*\*/);
  });

  it("lets only the app show it in a frame", () => {
    expect(csp).toContain("frame-ancestors https://app.example.app");
    expect(pageContentSecurityPolicy("https://p.example", [])).toContain("frame-ancestors 'none'");
  });
});

describe("injectPageRuntime", () => {
  it("goes first in the head, before the page's own scripts", () => {
    expect(
      injectPageRuntime('<!doctype html><html><head lang="en"><script>1</script>', runtime),
    ).toBe(`<!doctype html><html><head lang="en">${tag}<script>1</script>`);
  });

  it("doesn't mistake a <header> for the head", () => {
    expect(injectPageRuntime("<!DOCTYPE html><body><header>Hi</header>", runtime)).toBe(
      `<!DOCTYPE html>${tag}<body><header>Hi</header>`,
    );
  });

  it("works on a fragment", () => {
    expect(injectPageRuntime("<p>Hi</p>", runtime)).toBe(`${tag}<p>Hi</p>`);
  });
});

describe("parsePageAskMessage", () => {
  it("accepts a passage, as an object or the phone's JSON string", () => {
    const message = {
      source: "openbot-page",
      type: "ask",
      quote: "  a\n quote ",
      section: " Intro ",
    };
    const expected = { source: "openbot-page", type: "ask", quote: "a quote", section: "Intro" };
    expect(parsePageAskMessage(message)).toEqual(expected);
    expect(parsePageAskMessage(JSON.stringify(message))).toEqual(expected);
  });

  it("refuses anything else a page might send", () => {
    for (const data of [
      null,
      "not json",
      42,
      { source: "other", type: "ask", quote: "x" },
      { source: "openbot-page", type: "send", quote: "x" },
      { source: "openbot-page", type: "ask", quote: 5 },
      { source: "openbot-page", type: "ask", quote: "   " },
    ])
      expect(parsePageAskMessage(data)).toBeNull();
  });

  it("keeps quotes short and drops a section that isn't text", () => {
    const parsed = parsePageAskMessage({
      source: "openbot-page",
      type: "ask",
      quote: "q".repeat(5000),
      section: { evil: true },
    });
    expect(parsed?.quote).toHaveLength(MAX_PAGE_QUOTE);
    expect(parsed?.section).toBeNull();
  });
});

describe("pageQuestionText", () => {
  it("names the page and version, quotes the passage, then asks", () => {
    expect(
      pageQuestionText({
        pageId: "p1",
        title: "Caching",
        version: 3,
        quote: "line one\nline two",
        section: "How it works",
        text: " Why? ",
      }),
    ).toBe(
      "About your page “Caching” (page_id p1, version 3):\nSection: How it works\n> line one\n> line two\n\nWhy?",
    );
  });

  it("works without a passage", () => {
    expect(pageQuestionText({ pageId: "p1", title: "T", version: 1, text: "Add a chart" })).toBe(
      "About your page “T” (page_id p1, version 1):\n\nAdd a chart",
    );
  });
});

describe("pageViewQuery", () => {
  it("says only what's set", () => {
    expect(pageViewQuery({})).toBe("");
    expect(pageViewQuery({ theme: "dark", ask: true })).toBe("theme=dark&ask=1");
  });
});

describe("isPageSourcePath", () => {
  it("allows HTML in workspaces and the shared folder", () => {
    expect(isPageSourcePath("/home/bot/bots/iris/pages/kafka/index.html")).toBe(true);
    expect(isPageSourcePath("/home/bot/shared/report.htm")).toBe(true);
  });

  it("refuses everything else", () => {
    for (const path of [
      "/home/bot/bots/iris/../../.codex/auth.html",
      "/home/bot/bots/iris/.secret/page.html",
      "/home/bot/bots/iris/notes.md",
      "/etc/passwd.html",
      "/home/bot/bots/.html",
      "home/bot/shared/a.html",
    ])
      expect(isPageSourcePath(path)).toBe(false);
  });
});
