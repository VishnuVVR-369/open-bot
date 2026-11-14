import type { TeammateSummary, ChatSummary } from "@open-bot/api";

/**
 * The line under a chat's name in lists: what was said last ("You: …", and who said it in a
 * group), or else who is in the chat or what it is.
 */
export function chatSubtitle(
  chat: ChatSummary,
  teammate: TeammateSummary | undefined,
  teammates: TeammateSummary[],
): string {
  const { preview } = chat;
  if (preview) {
    if (!preview.teammateId) return `You: ${preview.text}`;
    if (chat.kind !== "group")
      // A chat titled after its topic says whose reply it is, as its title no longer does.
      return teammate && namedForTopic(chat, teammate)
        ? `${teammate.name}: ${preview.text}`
        : preview.text;
    const speaker = teammates.find((member) => member.id === preview.teammateId)?.name;
    return speaker ? `${speaker}: ${preview.text}` : preview.text;
  }
  switch (chat.kind) {
    case "group":
      return chat.memberIds
        .map((id) => teammates.find((member) => member.id === id)?.name)
        .filter(Boolean)
        .join(", ");
    case "scheduled":
      return "Scheduled tasks";
    case "inbox":
      return "Email";
    default:
      return teammate?.role ?? "Former teammate";
  }
}

/** What a chat is called in lists. */
/** A direct chat titled after what it's about, not named after its teammate. */
export function namedForTopic(
  chat: Pick<ChatSummary, "kind" | "title">,
  teammate: Pick<TeammateSummary, "name"> | undefined,
): boolean {
  return chat.kind === "direct" && Boolean(teammate) && chat.title !== teammate!.name;
}

export function chatTitle(chat: ChatSummary, teammate: TeammateSummary | undefined): string {
  if (chat.kind === "scheduled") return `${teammate?.name ?? ""} · Scheduled`;
  if (chat.kind === "inbox") return `${teammate?.name ?? ""} · Email`;
  return chat.title;
}

/** Your conversation with a teammate: its main chat, or else its most recently active direct chat. */
export function conversationWith(
  teammate: TeammateSummary,
  chats: ChatSummary[],
): ChatSummary | undefined {
  const direct = chats.filter((chat) => chat.kind === "direct" && chat.teammateId === teammate.id);
  return (
    direct.find((chat) => chat.id === teammate.directChatId) ??
    [...direct].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
  );
}
