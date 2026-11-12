/** @mentions in a group chat: `@Name` anywhere in a message addresses that teammate. */

interface Member {
  id: string;
  name: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The teammates a message mentions. Names are matched literally (so "C++" works), case-insensitively,
 * and only as a whole name: `@Rex` is not a mention of "Re".
 */
export function mentionedIds(text: string, members: readonly Member[]): string[] {
  return members
    .filter((member) => new RegExp(`(^|\\s)@${escape(member.name)}(?!\\w)`, "i").test(text))
    .map((member) => member.id);
}

/** The partial name being typed after an `@` just before the caret, or null. */
export function mentionQuery(text: string, caret: number): string | null {
  const match = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
  return match ? match[2]! : null;
}

/** The most teammates the @ menu offers at once. */
export const MENTION_OPTIONS = 6;

/** Teammates whose names start with the query, then those that contain it. */
export function mentionOptions<T extends Member>(members: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts = members.filter((member) => member.name.toLowerCase().startsWith(q));
  const contains = members.filter(
    (member) => !starts.includes(member) && member.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, MENTION_OPTIONS);
}

/** Replace the `@partial` before the caret with the full name, and say where the caret goes. */
export function insertMention(
  text: string,
  caret: number,
  member: Member,
): { text: string; caret: number } {
  const before = text.slice(0, caret).replace(/@([\w-]*)$/, () => `@${member.name} `);
  const after = text.slice(caret).replace(/^ /, "");
  return { text: before + after, caret: before.length };
}
