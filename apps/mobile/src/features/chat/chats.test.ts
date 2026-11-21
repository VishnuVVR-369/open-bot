import type { TeammateSummary, ChatSummary } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import { chatSubtitle, chatTitle, conversationWith } from "./chats";

const rex = { id: "rex", name: "Rex", role: "software engineer" } as TeammateSummary;
const iris = { id: "iris", name: "Iris", role: "research assistant" } as TeammateSummary;
const teammates = [rex, iris];

function chat(overrides: Partial<ChatSummary>): ChatSummary {
  return {
    id: "c",
    kind: "direct",
    title: "Rex",
    teammateId: "rex",
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
      preview: { text: "Done.", teammateId: "rex" },
    });
    expect(chatSubtitle(titled, rex, teammates)).toBe("Rex: Done.");
    expect(
      chatSubtitle({ ...titled, preview: { text: "Thanks", teammateId: null } }, rex, teammates),
    ).toBe("You: Thanks");
  });

  it("shows what was said last, and says when you said it", () => {
    expect(
      chatSubtitle(chat({ preview: { text: "Done.", teammateId: "rex" } }), rex, teammates),
    ).toBe("Done.");
    expect(
      chatSubtitle(chat({ preview: { text: "Thanks", teammateId: null } }), rex, teammates),
    ).toBe("You: Thanks");
  });

  it("says who spoke in a group", () => {
    const group = chat({
      kind: "group",
      title: "Launch",
      teammateId: null,
      memberIds: ["rex", "iris"],
    });
    expect(
      chatSubtitle(
        { ...group, preview: { text: "On it", teammateId: "iris" } },
        undefined,
        teammates,
      ),
    ).toBe("Iris: On it");
    expect(chatSubtitle(group, undefined, teammates)).toBe("Rex, Iris");
  });

  it("says who the teammate is in a chat with nothing in it yet", () => {
    expect(chatSubtitle(chat({}), rex, teammates)).toBe("software engineer");
    expect(chatSubtitle(chat({ kind: "scheduled" }), rex, teammates)).toBe("Scheduled tasks");
  });
});

describe("chat titles", () => {
  it("names a teammate's scheduled and email chats after it", () => {
    expect(chatTitle(chat({ kind: "scheduled" }), rex)).toBe("Rex · Scheduled");
    expect(chatTitle(chat({ kind: "inbox" }), rex)).toBe("Rex · Email");
    expect(chatTitle(chat({}), rex)).toBe("Rex");
  });
});

describe("conversationWith", () => {
  const older = chat({ id: "older", lastActivityAt: "2026-11-01T09:00:00Z" });
  const newer = chat({ id: "newer", lastActivityAt: "2026-11-10T09:00:00Z" });
  const group = chat({ id: "group", kind: "group", lastActivityAt: "2026-11-11T09:00:00Z" });

  it("opens the main chat, even when another direct chat is newer", () => {
    expect(conversationWith({ ...rex, directChatId: "older" }, [newer, older, group])?.id).toBe(
      "older",
    );
  });

  it("opens the newest direct chat when the main chat isn't in the list", () => {
    expect(conversationWith({ ...rex, directChatId: null }, [older, newer, group])?.id).toBe(
      "newer",
    );
  });
});
