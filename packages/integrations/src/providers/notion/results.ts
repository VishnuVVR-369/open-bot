// Reading what Notion's MCP server answers: text, data, background tasks and what a create made.
import { notionId } from "./effects";

export interface McpResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export function resultText(result: McpResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text!)
    .join("\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The result's data: its structured content, or its text as JSON. */
export function resultData(result: McpResult): unknown {
  return result.structuredContent ?? parseJson(resultText(result));
}

/** Ids of what a create made, from its result, so later changes to them count as the teammates'. */
export function createdIds(data: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["id", "page_id", "database_id", "data_source_id"]) {
      const raw = record[key];
      const id = typeof raw === "string" ? notionId(raw) : null;
      if (id) ids.add(id);
    }
    for (const key of ["pages", "result", "database", "data_sources", "data_source"])
      visit(record[key], depth + 1);
  };
  visit(data, 0);
  // Data sources also show up as collection:// links.
  for (const match of JSON.stringify(data ?? "").matchAll(/collection:\/\/([0-9a-f-]{32,36})/gi)) {
    const id = notionId(match[1]!);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Notion's answer that a write continues in the background. */
export function asyncTask(data: unknown): { id: string; pollAfterMs: number } | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const task =
    record.object === "async_task"
      ? record
      : (record.async_task as Record<string, unknown> | undefined);
  if (!task || typeof task.id !== "string") return null;
  const seconds = typeof task.poll_after_seconds === "number" ? task.poll_after_seconds : 2;
  return { id: task.id, pollAfterMs: Math.min(Math.max(seconds, 1), 30) * 1000 };
}

export function excerpt(value: unknown, max = 600): string {
  const text =
    typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
