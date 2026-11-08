/** Lines a long message shows until you open it. The web folds at the same count. */
export const FOLDED_LINES = 8;
/** A message folds only when that hides at least this many more lines, so it never hides just one. */
const MIN_HIDDEN_LINES = 4;
/**
 * Fewer characters than any phone fits on a line of a message bubble, even in landscape-split
 * or with the largest font. Only used to skip measuring messages that can't be long.
 */
const MIN_CHARS_PER_LINE = 12;

/** Whether a message laid out in `lines` lines folds. */
export function folds(lines: number): boolean {
  return lines >= FOLDED_LINES + MIN_HIDDEN_LINES;
}

/**
 * Whether `text` could take enough lines to fold at any width, so short messages skip the fold
 * and its measuring entirely. Errs toward yes: the laid-out line count decides.
 */
export function mightFold(text: string): boolean {
  let lines = 0;
  for (const paragraph of text.split("\n"))
    lines += Math.max(1, Math.ceil(paragraph.length / MIN_CHARS_PER_LINE));
  return folds(lines);
}
