import type { RunView } from "@open-bot/api";
import { isRunActive } from "@open-bot/shared";

export function completedRepliesKey(runs: Record<string, RunView>): string {
  return JSON.stringify(
    Object.values(runs)
      .filter((run) => !isRunActive(run.timeline.status) && run.completedAt)
      .map((run) => [run.id, run.completedAt])
      .sort(([a], [b]) => a!.localeCompare(b!)),
  );
}
