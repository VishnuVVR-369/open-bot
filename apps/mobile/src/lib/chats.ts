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
    if (chat.kind !== "group")
      // A chat titled after its topic says whose reply it is, as its title no longer does.
      return bot && namedForTopic(chat, bot) ? `${bot.name}: ${preview.text}` : preview.text;
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
/** A direct chat titled after what it's about, not named after its teammate. */
export function namedForTopic(
  chat: Pick<ChatSummary, "kind" | "title">,
  bot: Pick<BotSummary, "name"> | undefined,
): boolean {
  return chat.kind === "direct" && Boolean(bot) && chat.title !== bot!.name;
}

export function chatTitle(chat: ChatSummary, bot: BotSummary | undefined): string {
  if (chat.kind === "scheduled") return `${bot?.name ?? ""} · Scheduled`;
  if (chat.kind === "inbox") return `${bot?.name ?? ""} · Email`;
  return chat.title;
}
