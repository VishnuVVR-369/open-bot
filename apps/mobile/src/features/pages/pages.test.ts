import type { TeammateSummary, ChatSummary, PageDetail, PageSummary } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import {
  isLinkFresh,
  isPageAddress,
  newerVersion,
  openingVersion,
  pageHref,
  pageLoadFailure,
  pageSubtitle,
  pageThumbnailUrl,
  parsePageMessage,
  questionTarget,
  sortPages,
} from "./pages";

const iris = { id: "iris", name: "Iris", directChatId: "dm-iris" } as TeammateSummary;
const chat = (id: string, kind: ChatSummary["kind"]) => ({ id, kind, title: id }) as ChatSummary;

describe("page links", () => {
  it("opens a page at the version a card published", () => {
    expect(pageHref("p1")).toBe("/pages/p1");
    expect(pageHref("p1", "v2")).toBe("/pages/p1?v=v2");
  });

  it("asks for the picture in the theme you see", () => {
    expect(pageThumbnailUrl("v 1")).toMatch(/\/api\/pages\/versions\/v%201\/thumbnail$/);
    expect(pageThumbnailUrl("v1", "dark")).toMatch(/\/versions\/v1\/thumbnail\?theme=dark$/);
  });

  it("replaces a link before it runs out", () => {
    const now = Date.parse("2026-11-05T10:00:00Z");
    expect(isLinkFresh({ expiresAt: "2026-11-05T10:10:00Z" }, now)).toBe(true);
    expect(isLinkFresh({ expiresAt: "2026-11-05T10:00:20Z" }, now)).toBe(false);
    expect(isLinkFresh({ expiresAt: "2026-11-05T09:59:00Z" }, now)).toBe(false);
    expect(isLinkFresh({ expiresAt: "not a date" }, now)).toBe(false);
  });
});

describe("messages from a page", () => {
  it("reads Ask about this", () => {
    expect(
      parsePageMessage(
        JSON.stringify({ source: "openbot-page", type: "ask", quote: "  a  b ", section: "Intro" }),
      ),
    ).toEqual({ source: "openbot-page", type: "ask", quote: "a b", section: "Intro" });
  });

  it("opens only web and mail links outside the app", () => {
    const open = (url: string) =>
      parsePageMessage(JSON.stringify({ source: "openbot-page", type: "open", url }));
    expect(open("https://example.com/a?b=1")).toEqual({
      source: "openbot-page",
      type: "open",
      url: "https://example.com/a?b=1",
    });
    expect(open("mailto:a@example.com")?.type).toBe("open");
    expect(open("javascript:alert(1)")).toBeNull();
    expect(open("intent://scan/#Intent;scheme=zxing;end")).toBeNull();
    expect(open("openbot://settings")).toBeNull();
    expect(open("not a url")).toBeNull();
  });

  it("ignores anything else", () => {
    expect(parsePageMessage("hello")).toBeNull();
    expect(parsePageMessage(JSON.stringify({ type: "ask", quote: "x" }))).toBeNull();
    expect(parsePageMessage(JSON.stringify({ source: "openbot-page", type: "steal" }))).toBeNull();
  });
});

describe("where a question goes", () => {
  it("goes to the chat the page was made in", () => {
    const group = chat("g1", "group");
    expect(
      questionTarget(
        { teammateId: "iris", chatId: "g1" },
        [iris],
        [group, chat("dm-iris", "direct")],
      ),
    ).toEqual({ teammate: iris, chat: group });
  });

  it("falls back to the teammate's own chat for a scheduled or missing one", () => {
    const direct = chat("dm-iris", "direct");
    expect(
      questionTarget(
        { teammateId: "iris", chatId: "s1" },
        [iris],
        [chat("s1", "scheduled"), direct],
      ),
    ).toEqual({ teammate: iris, chat: direct });
    expect(questionTarget({ teammateId: "iris", chatId: null }, [iris], [direct])?.chat).toBe(
      direct,
    );
  });

  it("has nowhere to go once the teammate is gone", () => {
    expect(questionTarget({ teammateId: null, chatId: "dm-iris" }, [iris], [])).toBeNull();
    expect(questionTarget({ teammateId: "iris", chatId: null }, [iris], [])).toBeNull();
  });
});

describe("the page list", () => {
  it("puts pinned pages first, then the latest", () => {
    const page = (id: string, pinned: boolean, updatedAt: string) =>
      ({ id, pinned, updatedAt }) as PageSummary;
    const sorted = sortPages([
      page("old", false, "2026-11-01T00:00:00Z"),
      page("pinned", true, "2026-10-01T00:00:00Z"),
      page("new", false, "2026-11-04T00:00:00Z"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["pinned", "new", "old"]);
  });
});

describe("the page viewer", () => {
  const version = (id: string, number: number, createdAt = new Date().toISOString()) =>
    ({ id, number, createdAt }) as PageDetail["versions"][number];
  // Newest first, as the server sends them.
  const page = {
    versionId: "v3",
    versions: [version("v3", 3), version("v2", 2), version("v1", 1)],
  };

  it("opens at the version a link names, if the page has it, else the latest", () => {
    expect(openingVersion(page, "v2")).toBe("v2");
    expect(openingVersion(page, "gone")).toBe("v3");
    expect(openingVersion(page, undefined)).toBe("v3");
  });

  it("offers the newest version over an older one until it was offered", () => {
    expect(newerVersion(page, "v2", "v2")?.id).toBe("v3");
    expect(newerVersion(page, "v2", "v3")).toBeNull();
    expect(newerVersion(page, "v3", "v2")).toBeNull();
    expect(newerVersion(page, null, null)).toBeNull();
  });

  it("names the teammate and the version under the title", () => {
    expect(pageSubtitle(page, page.versions[0]!, "Iris")).toBe("Iris · Version 3");
    expect(pageSubtitle(page, page.versions[1]!, undefined)).toBe(
      "Former teammate · Version 2 (older)",
    );
    const single = { versionId: "v1", versions: [version("v1", 1)] };
    expect(pageSubtitle(single, single.versions[0]!, "Iris")).toBe("Iris · now");
    expect(pageSubtitle(single, null, "Iris")).toBe("Iris");
  });

  it("loads only the page itself, a place in it, or a blank frame", () => {
    const url = "https://pages.example/p/1?t=abc";
    expect(isPageAddress(url, url)).toBe(true);
    expect(isPageAddress(`${url}#costs`, url)).toBe(true);
    expect(isPageAddress("about:blank", url)).toBe(true);
    expect(isPageAddress("https://pages.example/p/2", url)).toBe(false);
  });

  it("renews a turned-down link once, rechecks a missing page, and shows the rest", () => {
    expect(pageLoadFailure(403, false)).toEqual({ kind: "renew" });
    expect(pageLoadFailure(403, true)).toEqual({
      kind: "show",
      message: "The link to this page expired. Try again for a new one.",
    });
    expect(pageLoadFailure(404, false)).toEqual({ kind: "recheck" });
    expect(pageLoadFailure(502, false)).toEqual({
      kind: "show",
      message: "open-bot's pages service didn't answer. Try again in a moment.",
    });
  });
});
