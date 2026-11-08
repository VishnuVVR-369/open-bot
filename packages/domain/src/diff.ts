export interface DiffLine {
  type: "same" | "added" | "removed";
  text: string;
}

/** The lines that stay, go and come between two texts, in order (a longest-common-subsequence diff). */
export function lineDiff(before: string, after: string): DiffLine[] {
  // Empty text has no lines, rather than one empty line.
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  // lengths[i][j]: the longest common run of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ type: "removed", text: a[i]! });
      i += 1;
    } else {
      lines.push({ type: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) lines.push({ type: "removed", text: a[i++]! });
  while (j < b.length) lines.push({ type: "added", text: b[j++]! });
  return lines;
}
