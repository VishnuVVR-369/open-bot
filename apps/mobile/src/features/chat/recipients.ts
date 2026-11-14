import { mentionedIds } from "@open-bot/chat-core";

/**
 * Whom a draft is addressed to (`Draft.mentions`), as the chat's members now: a teammate who left
 * the chat or was archived has no member, and a message can't be sent to them. The server would
 * drop that mention, and a group's lead would answer instead.
 */
export function recipients<M extends { id: string }>(
  mentions: readonly string[],
  members: readonly M[],
): { id: string; member: M | undefined }[] {
  return mentions.map((id) => ({ id, member: members.find((member) => member.id === id) }));
}

/**
 * The mentions a message is sent with: whom the draft is addressed to, then anyone `@Name`d in its
 * text. Only a group chat has them; a direct chat goes to its teammate.
 */
export function sendMentions<M extends { id: string; name: string }>(
  text: string,
  addressed: readonly string[],
  members: readonly M[],
  isGroup: boolean,
): string[] {
  return isGroup ? [...new Set([...addressed, ...mentionedIds(text, members)])] : [];
}
