import type { BotSummary, ChatSummary } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import { chatSubtitle, chatTitle } from "./chats";

const rex = { id: "rex", name: "Rex", role: "software engineer" } as BotSummary;
const iris = { id: "iris", name: "Iris", role: "research assistant" } as BotSummary;
const bots = [rex, iris];

function chat(overrides: Partial<ChatSummary>): ChatSummary {
  return {
    id: "c",
    kind: "direct",
    title: "Rex",
    botId: "rex",
    main: true,
    memberIds: ["rex"],
    lastActivityAt: "2026-11-02T00:00:00.000Z",
    active: false,
    unread: false,
    preview: null,
    ...overrides,
  };
}

describe("chat subtitles", () => {
  it("says whose reply it is once a direct chat is titled after its topic", () => {
    const titled = chat({
      title: "Fix the login redirect",
      preview: { text: "Done.", botId: "rex" },
    });
    expect(chatSubtitle(titled, rex, bots)).toBe("Rex: Done.");
    expect(chatSubtitle({ ...titled, preview: { text: "Thanks", botId: null } }, rex, bots)).toBe(
      "You: Thanks",
    );
  });

  it("shows what was said last, and says when you said it", () => {
    expect(chatSubtitle(chat({ preview: { text: "Done.", botId: "rex" } }), rex, bots)).toBe(
      "Done.",
    );
    expect(chatSubtitle(chat({ preview: { text: "Thanks", botId: null } }), rex, bots)).toBe(
      "You: Thanks",
    );
  });

  it("says who spoke in a group", () => {
    const group = chat({ kind: "group", title: "Launch", botId: null, memberIds: ["rex", "iris"] });
    expect(
      chatSubtitle({ ...group, preview: { text: "On it", botId: "iris" } }, undefined, bots),
    ).toBe("Iris: On it");
    expect(chatSubtitle(group, undefined, bots)).toBe("Rex, Iris");
  });

  it("says who the teammate is in a chat with nothing in it yet", () => {
    expect(chatSubtitle(chat({}), rex, bots)).toBe("software engineer");
    expect(chatSubtitle(chat({ kind: "scheduled" }), rex, bots)).toBe("Scheduled tasks");
  });
});

describe("chat titles", () => {
  it("names a teammate's scheduled and email chats after it", () => {
    expect(chatTitle(chat({ kind: "scheduled" }), rex)).toBe("Rex · Scheduled");
    expect(chatTitle(chat({ kind: "inbox" }), rex)).toBe("Rex · Email");
    expect(chatTitle(chat({}), rex)).toBe("Rex");
  });
});
