import { compactNumber, formatDollars, formatDuration, type RunStatus } from "@open-bot/domain";

/** Where a run's model logs are read. */
export function runInspectorHref(runId: string): string {
  return `/settings/model-logs/runs/${runId}`;
}

/** A cost in dollars; under a cent, to the hundredth of a cent so a single request still reads. */
export function formatCost(micros: number): string {
  if (micros <= 0) return "$0";
  if (micros >= 10_000) return formatDollars(micros);
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/** Tokens in and out, the way the reply footer counts them. */
export function formatTokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return "No usage";
  return `${compactNumber(input ?? 0)} in · ${compactNumber(output ?? 0)} out`;
}

/** How long between two times, or null when either is missing. */
export function between(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return null;
  return ms < 1000 ? `${ms} ms` : formatDuration(ms);
}

/** A size in characters or bytes, short. */
export function formatSize(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/** Codex's request kinds, in words. */
export function requestKindLabel(kind: string | null): string {
  switch (kind) {
    case "turn":
      return "Turn";
    case "prewarm":
      return "Prewarm";
    case "compaction":
      return "Compaction";
    case "memory":
      return "Memory";
    case null:
      return "Request";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

/** A run's status in the words the chat uses. */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "Up next";
    case "starting":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting for you";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Stopped";
  }
}

/** Codex's tool item types, in words. */
export function toolItemLabel(type: string): string {
  switch (type) {
    case "commandExecution":
      return "Command";
    case "fileChange":
      return "File change";
    case "mcpToolCall":
      return "MCP tool";
    case "dynamicToolCall":
      return "open-bot tool";
    case "webSearch":
      return "Web search";
    case "imageView":
      return "Image view";
    case "collabAgentToolCall":
      return "Agent tool";
    default:
      return type;
  }
}
