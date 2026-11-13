import type { ChatEntry, RunView } from "@open-bot/api";
import { isRunActive, type ChatStatus } from "@open-bot/domain";
import { lastActive } from "../../lib/time";

/**
 * The chat's rows, newest first: the list is inverted, so it starts at the bottom and stays there
 * as replies stream. Messages that joined a running turn show inside that turn, not on their own.
 */
export function timelineRows(entries: ChatEntry[], runs: Record<string, RunView>): ChatEntry[] {
  const steered = new Set<string>();
  for (const run of Object.values(runs))
    for (const item of run.timeline.items)
      if (item.kind === "user_message") steered.add(item.messageId);
  return entries
    .filter(
      (entry) =>
        entry.type !== "message" || (!entry.message.steeredRunId && !steered.has(entry.message.id)),
    )
    .reverse();
}

/** A run is superseded once the same teammate has run again after it, so it has no Try again. */
export function supersededRuns(entries: ChatEntry[]): Set<string> {
  const result = new Set<string>();
  const seen = new Set<string>();
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "run") continue;
    if (seen.has(entry.run.botId)) result.add(entry.run.id);
    seen.add(entry.run.botId);
  }
  return result;
}

/** The newest run still going, if any: what a new message adds to, and what Stop stops. */
export function latestActiveRun(runs: Record<string, RunView>): RunView | undefined {
  return Object.values(runs)
    .filter((run) => isRunActive(run.timeline.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * What the composer says before you type. While a run is waiting on you or paused for the
 * computer, nothing is being done right now, so a message is a note rather than an addition.
 */
export function composerPlaceholder({
  activeName,
  held,
  isGroup,
  name,
}: {
  /** The teammate whose run is going, or null when none is; undefined if their name is unknown. */
  activeName: string | null | undefined;
  held: boolean;
  isGroup: boolean;
  /** The teammate of a direct chat. */
  name: string | undefined;
}): string {
  if (activeName !== null)
    return held
      ? `Add a note for ${activeName ?? "your teammate"}…`
      : `Add to what ${activeName ?? "your teammate"} is doing…`;
  return isGroup ? "Message the group, @ to mention" : `Message ${name ?? "your teammate"}…`;
}

/**
 * The words under the chat's title: what is happening in this chat, or, when nothing is, when a
 * direct chat's teammate was last active (else their job); an idle group says nothing.
 */
export function headerText({
  status,
  isGroup,
  lastActiveAt,
  role,
}: {
  status: Pick<ChatStatus, "activity" | "label">;
  isGroup: boolean;
  lastActiveAt: string | null | undefined;
  role: string | undefined;
}): string | null {
  if (status.activity !== "idle") return status.label;
  if (isGroup) return null;
  return lastActiveAt ? lastActive(lastActiveAt) : (role ?? "");
}
