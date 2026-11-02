import { shellScript } from "@open-bot/shared";

/** An approval's detail with shell wrappers (`bash -lc '…'`) taken off its commands. */
export function approvalDetail(detail: string): string {
  return detail
    .split("\n")
    .map((line) => (line.startsWith("$ ") ? `$ ${shellScript(line.slice(2))}` : line))
    .join("\n");
}

/** Lines added and removed in a diff. */
export function diffStats(diff: string) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}
