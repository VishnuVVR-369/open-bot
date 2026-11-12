/**
 * What a teammate's turn shows: which steps fold away, which stay, how they're counted, and the
 * words for what the teammate is doing and how long they worked.
 */
import type { RunView } from "@open-bot/api";
import {
  formatDuration,
  shellScript,
  toolDisplay,
  type ComputerItem,
  type TimelineItem,
} from "@open-bot/domain";
import { plural } from "./format";

/** Items that stay visible when the steps are folded: the reply, and what needs you or failed. */
export function isPinned(item: TimelineItem): boolean {
  return (
    (item.kind === "message" && item.phase === "final") ||
    item.kind === "user_message" ||
    item.kind === "error" ||
    item.kind === "swarm" ||
    item.kind === "page" ||
    (item.kind === "approval" && item.decision === "pending") ||
    (item.kind === "takeover_request" &&
      (item.resolution === "pending" || item.resolution === "taken"))
  );
}

/** A turn's items, with each stretch of computer actions in a row as one part. */
export type Segment =
  | { kind: "computer"; id: string; items: ComputerItem[] }
  | { kind: "item"; id: string; item: TimelineItem };

export function segments(items: readonly TimelineItem[]): Segment[] {
  const result: Segment[] = [];
  for (const item of items) {
    const last = result.at(-1);
    if (item.kind === "computer") {
      if (last?.kind === "computer") last.items.push(item);
      else result.push({ kind: "computer", id: item.id, items: [item] });
    } else {
      result.push({ kind: "item", id: item.id, item });
    }
  }
  return result;
}

/**
 * Steps the pending approval right after them already states, like "Asked to pay $842.30" above
 * the payment card. A tool that asks blocks on the answer, so it is still running, or it is one of
 * the tools that exist to ask.
 */
function restatedSteps(shown: readonly TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  shown.forEach((item, index) => {
    const next = shown[index + 1];
    if (
      item.kind === "tool" &&
      next?.kind === "approval" &&
      next.decision === "pending" &&
      (item.status === "running" || toolDisplay(item.name).asksApproval)
    )
      ids.add(item.id);
  });
  return ids;
}

/**
 * Approved commands that ran right after their approval. The command step says it once, marked as
 * approved, instead of an approval line followed by the same command again.
 */
function approvedCommands(shown: readonly TimelineItem[]): {
  approvals: Set<string>;
  commands: Set<string>;
} {
  const approvals = new Set<string>();
  const commands = new Set<string>();
  shown.forEach((item, index) => {
    const next = shown[index + 1];
    if (
      item.kind === "approval" &&
      item.decision === "approved" &&
      item.approvalKind === "command" &&
      next?.kind === "command" &&
      item.title.trim() === shellScript(next.command).trim()
    ) {
      approvals.add(item.id);
      commands.add(next.id);
    }
  });
  return { approvals, commands };
}

/**
 * The parts of a turn as it shows them, without steps that only repeat the next one, and which
 * command steps to mark "you approved". `steps` is how many fold away: a stretch of computer use
 * counts once, and pinned items and empty thinking don't count.
 */
export function turnParts(items: readonly TimelineItem[]): {
  parts: Segment[];
  approved: ReadonlySet<string>;
  steps: number;
} {
  // Computer actions sit between the steps these two compare, so they look past them.
  const shown = items.filter((item) => item.kind !== "computer");
  const merged = approvedCommands(shown);
  const hidden = new Set([...restatedSteps(shown), ...merged.approvals]);
  const parts = segments(hidden.size ? items.filter((item) => !hidden.has(item.id)) : items);
  const steps = parts.filter(
    (part) =>
      part.kind === "computer" ||
      (!isPinned(part.item) && !(part.item.kind === "reasoning" && !part.item.text)),
  ).length;
  return { parts, approved: merged.commands, steps };
}

/** The reply: the final messages' text, for copying and reading aloud. */
export function replyText(items: readonly TimelineItem[]): string {
  return items
    .flatMap((item) =>
      item.kind === "message" && item.phase === "final" ? [item.text.trim()] : [],
    )
    .filter(Boolean)
    .join("\n\n");
}

/** The approval or takeover request the turn is waiting on you for, if one is pending. */
export function pendingRequest(items: readonly TimelineItem[]): TimelineItem | undefined {
  return items.find(
    (item) =>
      (item.kind === "approval" && item.decision === "pending") ||
      (item.kind === "takeover_request" && item.resolution === "pending"),
  );
}

/** What the teammate is doing right now, in a few words, from their latest step. */
export function currentActivity(items: readonly TimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    switch (item.kind) {
      case "command":
        return `Running ${shellScript(item.command).split("\n")[0]}`;
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

/**
 * The line under a turn that's still going: "Up next", "Getting ready", then what it's doing, or
 * "Working". Leave out the activity where the running steps already show right above the line.
 */
export function workingText(
  run: Pick<RunView, "timeline">,
  { activity = true }: { activity?: boolean } = {},
): string {
  const { status, items } = run.timeline;
  if (status === "queued") return "Up next";
  if (status === "starting") return "Getting ready";
  return (activity && status === "running" && currentActivity(items)) || "Working";
}

/**
 * How long the teammate worked, in ms: until the turn finished, or until it stopped to wait on
 * you. Null while it's still working or before it started.
 */
export function workDuration(
  run: Pick<RunView, "startedAt" | "completedAt" | "timeline">,
): number | null {
  if (!run.startedAt) return null;
  const end =
    run.completedAt ??
    (run.timeline.status === "waiting" ? pendingRequest(run.timeline.items)?.startedAt : undefined);
  if (!end) return null;
  return Math.max(0, new Date(end).getTime() - new Date(run.startedAt).getTime());
}

/** The steps toggle's words: "Worked for 8s · 2 steps", or "2 steps" without a duration. */
export function workSummary(duration: number | null, steps: number): string {
  const count = plural(steps, "step");
  return duration === null ? count : `Worked for ${formatDuration(duration)} · ${count}`;
}
