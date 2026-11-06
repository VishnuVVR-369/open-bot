/** Matching for the command menu: words match where a word starts, not in the middle of one. */

/** The words of a query, lower-cased. */
export function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where `word` starts a word in a text: "lis" in "Lisbon", not in "Publish". */
function wordStart(word: string, flags = "iu") {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}`, flags);
}

/**
 * How well texts match the query, or null when some word starts no word in them. Higher is
 * better: a match at the very start of the first text (the title) beats one further in.
 */
export function matchScore(texts: string[], words: string[]): number | null {
  if (words.length === 0) return 0;
  const haystack = texts.join(" \u0000 ");
  if (!words.every((word) => wordStart(word).test(haystack))) return null;
  const title = (texts[0] ?? "").toLowerCase();
  if (title.startsWith(words.join(" "))) return 3;
  if (words.every((word) => wordStart(word).test(title))) return 2;
  return 1;
}

/** True when every word starts a word somewhere in the text. */
export function startsWords(text: string, words: string[]): boolean {
  return words.length > 0 && words.every((word) => wordStart(word).test(text));
}

/**
 * The text in parts, with each word of the query marked where it starts a word. A word found
 * only inside other words is marked there instead, so a match is never invisible.
 */
export function highlightParts(text: string, words: string[]): { text: string; mark: boolean }[] {
  const ranges: [number, number][] = [];
  for (const word of words) {
    let found = false;
    for (const match of text.matchAll(wordStart(word, "giu"))) {
      ranges.push([match.index, match.index + match[0].length]);
      found = true;
    }
    if (!found) {
      const index = text.toLowerCase().indexOf(word);
      if (index >= 0) ranges.push([index, index + word.length]);
    }
  }
  if (ranges.length === 0) return [{ text, mark: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) parts.push({ text: text.slice(at, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}
