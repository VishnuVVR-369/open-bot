import type { TeammateSummary, ChatSummary, PageSummary, SearchResult } from "@open-bot/api";
import { preferWordStarts, rankMatches } from "@open-bot/chat-core";
import { chatSubtitle, chatTitle } from "../chat/chats";

type Teammate = TeammateSummary;

/** What to look through: everything, or one kind of thing. Messages are searched on the server. */
export const SCOPES = [
  { key: "all", label: "All" },
  { key: "teammates", label: "Teammates" },
  { key: "chats", label: "Chats" },
  { key: "pages", label: "Pages" },
  { key: "messages", label: "Messages" },
] as const;
export type Scope = (typeof SCOPES)[number]["key"];

/** A place in the app search can go to, found by its title or its keywords. */
export interface Place {
  title: string;
  keywords: string;
}

export type SearchRow<P extends Place = Place> =
  | { kind: "teammate"; key: string; teammate: Teammate }
  | {
      kind: "chat";
      key: string;
      chatId: string;
      chatKind: ChatSummary["kind"];
      title: string;
      subtitle: string;
      teammate?: Teammate;
      members?: Teammate[];
    }
  | ({ kind: "place"; key: string } & P)
  /** A page a teammate made. */
  | { kind: "page"; key: string; page: PageSummary; teammate?: Teammate }
  | {
      kind: "message";
      key: string;
      result: SearchResult;
      /** Who said it: a teammate, or you (undefined). */
      teammate?: Teammate;
      /** Who said it, and where when that adds something: "Rex", "You to Rex", "Iris in Trip". */
      who: string;
      where: string | null;
    };

export interface SearchSection<P extends Place = Place> {
  scope: Scope;
  title: string;
  data: SearchRow<P>[];
}

/**
 * What search shows for what you typed, in sections. With every scope, each kind is capped, and
 * recent chats and teammates show before you type; one scope shows all it finds. Each word you
 * type has to start a word in what it finds. Pages a teammate made and messages need a query,
 * and messages need two letters.
 */
export function searchSections<P extends Place>(input: {
  words: string[];
  query: string;
  scope: Scope;
  teammates: Teammate[];
  chats: ChatSummary[];
  pages: PageSummary[];
  places: P[];
  messages: SearchResult[];
}): SearchSection<P>[] {
  const { words, query, scope, teammates, chats } = input;
  const only = scope !== "all";
  const teammateOf = (id: string | null | undefined) =>
    teammates.find((candidate) => candidate.id === id);

  const teammateRows: SearchRow<P>[] = rankMatches(
    teammates,
    (teammate) => [teammate.name, teammate.role],
    words,
  )
    .slice(0, only ? undefined : query ? 6 : 8)
    .map((teammate) => ({ kind: "teammate", key: `b:${teammate.id}`, teammate }));
  const recent = [...chats]
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .map((chat) => {
      const teammate = teammateOf(chat.teammateId);
      return {
        kind: "chat" as const,
        key: `c:${chat.id}`,
        chatId: chat.id,
        chatKind: chat.kind,
        title: chatTitle(chat, teammate),
        subtitle: chatSubtitle(chat, teammate, teammates),
        teammate: chat.kind === "group" ? undefined : teammate,
        members:
          chat.kind === "group"
            ? chat.memberIds
                .map((id) => teammateOf(id))
                .filter((member): member is Teammate => Boolean(member))
            : undefined,
      };
    });
  const chatRows: SearchRow<P>[] = rankMatches(
    recent,
    (row) => [row.title, row.subtitle],
    words,
  ).slice(0, only ? undefined : query ? 8 : 5);
  const pageRows: SearchRow<P>[] = query
    ? rankMatches(input.pages, (page) => [page.title, page.summary], words)
        .slice(0, only ? undefined : 5)
        .map((page) => ({
          kind: "page",
          key: `pg:${page.id}`,
          page,
          teammate: teammateOf(page.teammateId),
        }))
    : [];
  const placeRows: SearchRow<P>[] = rankMatches(
    input.places,
    (place) => [place.title, place.keywords],
    words,
  ).map((place) => ({ kind: "place", key: `p:${place.title}`, ...place }));
  const messageRows: SearchRow<P>[] =
    query.length >= 2
      ? preferWordStarts(input.messages, (result) => result.excerpt, words).map((result) =>
          messageRow(result, chats, teammates),
        )
      : [];
  const all: SearchSection<P>[] = [
    { scope: "teammates", title: "Teammates", data: teammateRows },
    { scope: "chats", title: query ? "Chats" : "Recent chats", data: chatRows },
    { scope: "pages", title: "Pages", data: pageRows },
    { scope: "messages", title: "Messages", data: messageRows },
    { scope: "all", title: "Go to", data: placeRows },
  ];
  return all.filter(
    (section) => section.data.length > 0 && (scope === "all" || section.scope === scope),
  );
}

/** A found message, with who said it and where, when the chat's name doesn't already say so. */
function messageRow(
  result: SearchResult,
  chats: ChatSummary[],
  teammates: Teammate[],
): Extract<SearchRow, { kind: "message" }> {
  const chat = chats.find((candidate) => candidate.id === result.chatId);
  const chatTeammate = teammates.find((candidate) => candidate.id === chat?.teammateId);
  const teammate = teammates.find((candidate) => candidate.id === result.teammateId);
  const place = chat ? chatTitle(chat, chatTeammate) : null;
  const direct = chat?.kind === "direct";
  const speaker = result.from === "you" ? "You" : (teammate?.name ?? "A teammate");
  // A direct chat is named after its teammate: "Rex in Rex" says nothing new.
  const where =
    result.from === "you"
      ? place && (direct ? `to ${place}` : `in ${place}`)
      : place && place !== speaker && !(direct && chatTeammate?.id === teammate?.id)
        ? `in ${place}`
        : null;
  return {
    kind: "message",
    key: `m:${result.id}`,
    result,
    teammate: result.from === "you" ? undefined : teammate,
    who: speaker,
    where,
  };
}
