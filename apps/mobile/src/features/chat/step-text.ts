import { diffStats } from "@open-bot/chat-core";
import { shellScript, type TimelineItem } from "@open-bot/domain";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

/** A thought's first non-empty line, without bold marks; "Thinking" when it has none yet. */
export function reasoningSummary(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.replace(/\*\*/g, "") ?? "Thinking"
  );
}

/**
 * A command as one line: the script, its exit code when it failed, and whether you approved it
 * just before it ran.
 */
export function commandStep(item: Item<"command">, approved: boolean) {
  const command = shellScript(item.command);
  const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
  return {
    command,
    failed: failed && item.status !== "running",
    summary: [
      command,
      failed && item.exitCode !== null && `exit ${item.exitCode}`,
      approved && "you approved",
    ]
      .filter(Boolean)
      .join("  · "),
  };
}

/**
 * A file change as one line: what was done, to which files (the last two parts of each path), and
 * the lines added and removed when it is one file with a diff.
 */
export function fileChangeSummary(item: Item<"file_change">): string {
  const name = (path: string) => path.split("/").slice(-2).join("/");
  const verb = item.changes.every((c) => c.change === "add")
    ? "Created"
    : item.changes.every((c) => c.change === "delete")
      ? "Deleted"
      : "Edited";
  const only = item.changes.length === 1 ? item.changes[0] : undefined;
  const stats = only?.diff ? diffStats(only.diff) : null;
  return `${verb} ${item.changes.map((c) => name(c.path)).join(", ")}${
    stats ? `  +${stats.added} −${stats.removed}` : ""
  }`;
}

/** A tool call as one line: its label, its result, and its error when it failed. */
export function toolSummary(item: Item<"tool">): string {
  return [item.label, item.result, item.status === "failed" ? item.error : undefined]
    .filter(Boolean)
    .join(" · ");
}

export const webSearchSummary = (query: string | null | undefined) =>
  query ? `Searched the web for “${query}”` : "Searched the web";

/** What became of a teammate's request that you take over their screen. */
export function takeoverTitle(resolution: Item<"takeover_request">["resolution"], name: string) {
  return resolution === "pending"
    ? `${name} needs you to take over`
    : resolution === "taken"
      ? "You're in control of the screen"
      : resolution === "handed_back"
        ? "You handed the screen back"
        : "Dismissed";
}

export const handBackText = (note: string) =>
  note ? `You handed the screen back: “${note}”` : "You handed the screen back";

/** Items that are cards in a turn, which get a little room after them. */
export const CARD_KINDS: readonly TimelineItem["kind"][] = [
  "approval",
  "takeover_request",
  "plan",
  "swarm",
  "page",
  "user_message",
];
