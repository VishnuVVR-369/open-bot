import { shellScript } from "../approvals/rules";
import type { TimelineItem } from "./timeline";

export interface ActivityOptions {
  /**
   * How much of a command to say: its first `line` (in the app), or only the `program` it runs,
   * for text that leaves the app, like a phone notification, where arguments could hold secrets.
   */
  command?: "line" | "program";
}

/** What the teammate is doing right now, in a few words, from their latest step. */
export function currentActivity(
  items: readonly TimelineItem[],
  { command = "line" }: ActivityOptions = {},
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    switch (item.kind) {
      case "command": {
        const line = shellScript(item.command).split("\n")[0]!;
        if (command === "line") return `Running ${line}`;
        const program = line.trim().split(/\s+/)[0]?.split("/").pop();
        return program ? `Running ${program}` : "Running a command";
      }
      case "file_change":
        return `Editing ${item.changes.map((change) => change.path.split("/").pop()).join(", ")}`;
      case "web_search":
        return item.query ? `Searching for “${item.query}”` : "Searching the web";
      case "computer":
        return "Using the computer";
      case "tool":
        return item.label;
      case "reasoning":
        return "Thinking";
      case "message":
        return item.phase === "final" ? "Writing" : null;
      default:
        continue;
    }
  }
  return null;
}
