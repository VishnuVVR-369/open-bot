import type { BotSummary, ChatSummary, PageSummary } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import {
  isLinkFresh,
  pageHref,
  pageThumbnailUrl,
  parsePageMessage,
  questionTarget,
  sortPages,
} from "./pages";

const iris = { id: "iris", name: "Iris", directChatId: "dm-iris" } as BotSummary;
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
      questionTarget({ botId: "iris", chatId: "g1" }, [iris], [group, chat("dm-iris", "direct")]),
    ).toEqual({ bot: iris, chat: group });
  });

  it("falls back to the teammate's own chat for a scheduled or missing one", () => {
    const direct = chat("dm-iris", "direct");
    expect(
      questionTarget({ botId: "iris", chatId: "s1" }, [iris], [chat("s1", "scheduled"), direct]),
    ).toEqual({ bot: iris, chat: direct });
    expect(questionTarget({ botId: "iris", chatId: null }, [iris], [direct])?.chat).toBe(direct);
  });

  it("has nowhere to go once the teammate is gone", () => {
    expect(questionTarget({ botId: null, chatId: "dm-iris" }, [iris], [])).toBeNull();
    expect(questionTarget({ botId: "iris", chatId: null }, [iris], [])).toBeNull();
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
