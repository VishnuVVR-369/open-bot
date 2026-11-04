import type { BotSummary, ChatSummary } from "@open-bot/api";

/**
 * The line under a chat's name in lists: what was said last ("You: …", and who said it in a
 * group), or else who is in the chat or what it is.
 */
export function chatSubtitle(
  chat: ChatSummary,
  bot: BotSummary | undefined,
  bots: BotSummary[],
): string {
  const { preview } = chat;
  if (preview) {
    if (!preview.botId) return `You: ${preview.text}`;
    if (chat.kind !== "group") return preview.text;
    const speaker = bots.find((member) => member.id === preview.botId)?.name;
    return speaker ? `${speaker}: ${preview.text}` : preview.text;
  }
  switch (chat.kind) {
    case "group":
      return chat.memberIds
        .map((id) => bots.find((member) => member.id === id)?.name)
        .filter(Boolean)
        .join(", ");
    case "scheduled":
      return "Scheduled tasks";
    case "inbox":
      return "Email";
    default:
      return bot?.role ?? "Former teammate";
  }
}

/** What a chat is called in lists. */
export function chatTitle(chat: ChatSummary, bot: BotSummary | undefined): string {
  if (chat.kind === "scheduled") return `${bot?.name ?? ""} · Scheduled`;
  if (chat.kind === "inbox") return `${bot?.name ?? ""} · Email`;
  return chat.title;
}
