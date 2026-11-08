/** @mentions in a group chat: `@Name` anywhere in a message addresses that teammate. */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The teammates a message mentions. Names are matched literally (so "C++" works), case-insensitively,
 * and only as a whole name: `@Rex` is not a mention of "Re".
 */
export function mentionedIds(text: string, members: { id: string; name: string }[]): string[] {
  return members
    .filter((member) => new RegExp(`(^|\\s)@${escape(member.name)}(?!\\w)`, "i").test(text))
    .map((member) => member.id);
}
