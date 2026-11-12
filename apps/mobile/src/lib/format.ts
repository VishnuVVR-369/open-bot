import { shellScript } from "@open-bot/domain";

/** An approval's detail with shell wrappers (`bash -lc '…'`) taken off its commands. */
export function approvalDetail(detail: string): string {
  return detail
    .split("\n")
    .map((line) => (line.startsWith("$ ") ? `$ ${shellScript(line.slice(2))}` : line))
    .join("\n");
}
