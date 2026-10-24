import type { v2 } from "@open-bot/agent";
import type { TimelineItem } from "@open-bot/shared";

type ThreadItem = v2.ThreadItem;

function changeKind(kind: v2.PatchChangeKind): "add" | "delete" | "update" {
  return kind.type;
}

/**
 * Map a Codex thread item to what the timeline shows.
 * Returns null for items the timeline doesn't show (user messages, and our own dynamic tools,
 * which the tool handlers record themselves with richer detail).
 */
export function mapThreadItem(
  item: ThreadItem,
  phase: "started" | "completed",
  now: string,
  startedAt?: string,
): TimelineItem | null {
  const status = phase === "completed" ? "completed" : "running";
  const base = {
    id: item.id,
    status,
    startedAt: startedAt ?? now,
    ...(phase === "completed" ? { completedAt: now } : {}),
  } as const;

  switch (item.type) {
    case "agentMessage":
      return {
        ...base,
        kind: "message",
        text: item.text,
        phase: item.phase === "commentary" ? "commentary" : "final",
      };
    case "reasoning": {
      const text = item.summary.join("\n\n").trim();
      // Reasoning without a summary has nothing to show.
      if (phase === "completed" && !text) return null;
      return { ...base, kind: "reasoning", text };
    }
    case "commandExecution": {
      const failed = item.status === "failed" || item.status === "declined";
      return {
        ...base,
        status: phase === "completed" ? (failed ? "failed" : "completed") : "running",
        kind: "command",
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      };
    }
    case "fileChange":
      return {
        ...base,
        status:
          phase === "completed" && (item.status === "failed" || item.status === "declined")
            ? "failed"
            : status,
        kind: "file_change",
        changes: item.changes.map((change) => ({
          path: change.path,
          change: changeKind(change.kind),
          diff: change.diff,
        })),
      };
    case "plan":
      return null;
    case "webSearch":
      return { ...base, kind: "web_search", query: item.query };
    case "mcpToolCall":
      return {
        ...base,
        status: phase === "completed" && item.error ? "failed" : status,
        kind: "tool",
        name: `${item.server}.${item.tool}`,
        label: `Used ${item.tool.replace(/_/g, " ")}`,
        args: item.arguments,
        ...(item.error ? { error: item.error.message } : {}),
      };
    default:
      return null;
  }
}

export function mapPlan(plan: v2.TurnPlanStep[], id: string, now: string): TimelineItem {
  return {
    id,
    kind: "plan",
    status: plan.every((step) => step.status === "completed") ? "completed" : "running",
    startedAt: now,
    steps: plan.map((step) => ({ step: step.step, status: step.status })),
  };
}

/** The final answer of a turn: the last final-phase agent message, else the last message. */
export function finalText(items: TimelineItem[]): string | null {
  const messages = items.filter((item) => item.kind === "message");
  const final = [...messages].reverse().find((item) => item.phase === "final") ?? messages.at(-1);
  return final?.text.trim() || null;
}
