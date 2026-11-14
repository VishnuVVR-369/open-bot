import type { BotSummary, ChatSummary, PageSummary, SearchResult } from "@open-bot/api";
import { queryWords } from "@open-bot/chat-core";
import { describe, expect, it } from "vitest";
import { searchSections, type Scope } from "./search";

const teammate = (id: string, name: string, role = "Assistant") =>
  ({ id, name, role, directChatId: `dm-${id}` }) as BotSummary;
const team = [
  teammate("rex", "Rex", "Researcher"),
  teammate("iris", "Iris", "Travel"),
  ...Array.from({ length: 8 }, (_, i) => teammate(`t${i}`, `Helper ${i}`)),
];
const chat = (id: string, fields: Partial<ChatSummary>) =>
  ({
    id,
    kind: "direct",
    title: id,
    memberIds: [],
    lastActivityAt: "2026-11-10T00:00:00Z",
    ...fields,
  }) as ChatSummary;
const chats = [
  chat("dm-rex", { title: "Rex", botId: "rex", lastActivityAt: "2026-11-12T00:00:00Z" }),
  chat("dm-iris", { title: "Iris", botId: "iris", lastActivityAt: "2026-11-13T00:00:00Z" }),
  chat("trip", { kind: "group", title: "Lisbon trip", memberIds: ["iris", "rex", "gone"] }),
];
const pages = [
  { id: "p1", title: "Lisbon itinerary", summary: "Day by day", botId: "iris" },
] as PageSummary[];
const places = [
  { title: "Settings", keywords: "account lock" },
  { title: "Pages", keywords: "html reports" },
];
const result = (id: string, fields: Partial<SearchResult>) =>
  ({
    id,
    excerpt: "the hotel in Lisbon",
    createdAt: "2026-11-12T00:00:00Z",
    ...fields,
  }) as SearchResult;

/** What a search result says a teammate said; the API still calls it this. */
const BY_TEAMMATE = "bot" as const; // vocabulary: allow

type Data = Pick<Parameters<typeof searchSections>[0], "teammates" | "chats" | "pages">;
const search = (
  text: string,
  scope: Scope = "all",
  messages: SearchResult[] = [],
  data: Partial<Data> = {},
) =>
  searchSections({
    words: queryWords(text),
    query: text.trim().toLowerCase(),
    scope,
    teammates: team,
    chats,
    pages,
    places,
    messages,
    ...data,
  });
const titles = (sections: ReturnType<typeof search>) =>
  sections.map((section) => `${section.title}: ${section.data.map((row) => row.key).join(" ")}`);

describe("searchSections", () => {
  it("shows teammates, recent chats and places before you type", () => {
    const sections = search("");
    expect(sections.map((section) => section.title)).toEqual([
      "Teammates",
      "Recent chats",
      "Go to",
    ]);
    // Eight teammates at most, and the five latest chats, newest first.
    expect(sections[0]!.data).toHaveLength(8);
    expect(sections[1]!.data.map((row) => row.key)).toEqual(["c:dm-iris", "c:dm-rex", "c:trip"]);
  });

  it("finds what starts a word, across teammates, chats and the pages they made", () => {
    expect(titles(search("lis"))).toEqual(["Chats: c:trip", "Pages: pg:p1"]);
    expect(titles(search("set"))).toEqual(["Go to: p:Settings"]);
  });

  it("names a group by its members, leaving out teammates who are gone", () => {
    const [chats] = search("lisbon trip", "chats");
    const row = chats!.data[0]!;
    expect(row.kind === "chat" && row.members?.map((member) => member.id)).toEqual(["iris", "rex"]);
    expect(row.kind === "chat" && row.teammate).toBeUndefined();
  });

  it("keeps one scope, uncapped and without the others", () => {
    const sections = search("helper", "teammates");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.data).toHaveLength(8);
    expect(search("helper", "chats")).toEqual([]);
  });

  it("caps each kind with every scope, and shows all of one scope", () => {
    const many: Data = {
      teammates: Array.from({ length: 10 }, (_, i) => teammate(`h${i}`, `Standup helper ${i}`)),
      chats: Array.from({ length: 10 }, (_, i) =>
        chat(`s${i}`, {
          kind: "group",
          title: `Standup ${i}`,
          lastActivityAt: `2026-11-1${i}T00:00:00Z`,
        }),
      ),
      pages: Array.from(
        { length: 7 },
        (_, i) => ({ id: `r${i}`, title: `Standup notes ${i}`, summary: "" }) as PageSummary,
      ),
    };
    const counts = (text: string, scope: Scope = "all") =>
      Object.fromEntries(
        search(text, scope, [], many).map((section) => [section.title, section.data.length]),
      );
    expect(counts("standup")).toEqual({ Teammates: 6, Chats: 8, Pages: 5 });
    expect(counts("")).toEqual({ Teammates: 8, "Recent chats": 5, "Go to": 2 });
    expect(search("", "all", [], many)[1]!.data.map((row) => row.key)).toEqual([
      "c:s9",
      "c:s8",
      "c:s7",
      "c:s6",
      "c:s5",
    ]);
    expect(counts("standup", "teammates")).toEqual({ Teammates: 10 });
    expect(counts("standup", "chats")).toEqual({ Chats: 10 });
    expect(counts("standup", "pages")).toEqual({ Pages: 7 });
  });

  it("matches a role, a chat's last message, a page's summary and a place's keywords", () => {
    const booked = chat("plans", {
      kind: "group",
      title: "Plans",
      preview: { botId: null, text: "Booked the flights" } as ChatSummary["preview"], // vocabulary: allow
    });
    expect(titles(search("travel", "teammates"))).toEqual(["Teammates: b:iris"]);
    expect(titles(search("booked", "all", [], { chats: [...chats, booked] }))).toEqual([
      "Chats: c:plans",
    ]);
    expect(titles(search("day"))).toEqual(["Pages: pg:p1"]);
    expect(titles(search("lock"))).toEqual(["Go to: p:Settings"]);
    // Inside a word is not a match.
    expect(search("ravel")).toEqual([]);
    expect(search("isbon")).toEqual([]);
  });

  it("says who said a message, and where when the chat's name doesn't", () => {
    const messages = [
      result("m1", { from: "you", chatId: "dm-rex" }),
      result("m2", { from: BY_TEAMMATE, botId: "rex", chatId: "dm-rex" }),
      result("m3", { from: BY_TEAMMATE, botId: "iris", chatId: "trip" }),
      result("m4", { from: "you", chatId: "trip" }),
    ] as SearchResult[];
    const [section] = search("hotel", "messages", messages);
    expect(
      section!.data.map((row) => (row.kind === "message" ? [row.who, row.where] : null)),
    ).toEqual([
      ["You", "to Rex"],
      ["Rex", null],
      ["Iris", "in Lisbon trip"],
      ["You", "in Lisbon trip"],
    ]);
  });

  it("needs two letters before it shows messages", () => {
    expect(search("h", "messages", [result("m1", { from: "you", chatId: "dm-rex" })])).toEqual([]);
  });
});
