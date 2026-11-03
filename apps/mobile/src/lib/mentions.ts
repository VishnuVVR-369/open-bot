/**
 * @mentions in a group chat, the same way the web composer reads them: `@Name` anywhere in the
 * message addresses that teammate. Platform-free, so it's tested in Node.
 */

interface Member {
  id: string;
  name: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The partial name being typed after an `@` just before the caret, or null. */
export function mentionQuery(text: string, caret: number): string | null {
  const match = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
  return match ? match[2]! : null;
}

/** Teammates whose names start with (then contain) the query. */
export function mentionOptions<T extends Member>(members: T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts = members.filter((member) => member.name.toLowerCase().startsWith(q));
  const contains = members.filter(
    (member) => !starts.includes(member) && member.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, 6);
}

/** Replace the `@partial` before the caret with the full name, and say where the caret goes. */
export function insertMention(
  text: string,
  caret: number,
  member: Member,
): { text: string; caret: number } {
  const before = text.slice(0, caret).replace(/@([\w-]*)$/, `@${member.name} `);
  const after = text.slice(caret).replace(/^ /, "");
  return { text: before + after, caret: before.length };
}

/** The teammates a message mentions. */
export function mentionedIds(text: string, members: Member[]): string[] {
  return members
    .filter((member) => new RegExp(`(^|\\s)@${escape(member.name)}(\\b|$)`, "i").test(text))
    .map((member) => member.id);
}
