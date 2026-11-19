// Tools across runs: what each app-server tool item is called in the Tools tab, whether it
// failed, and what it was given and gave back. The web app's SQL mirrors `toolNameOf` and
// `toolItemFailed`; both are checked against each other in its integration tests.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The names the Tools tab gives tool items that carry no tool name of their own. */
export const TOOL_KIND_NAMES: Record<string, string> = {
  commandExecution: "Shell command",
  fileChange: "File edit",
  webSearch: "Web search",
  imageView: "Image view",
  imageGeneration: "Image generation",
  functionCallOutput: "Tool output",
};

/**
 * What the Tools tab calls a tool item: an open-bot tool by its namespace and name
 * (`tasks.add_task`), an MCP tool by its server and name (`github.create_issue`), a teammate tool
 * by its name, and anything else by its kind ("Shell command").
 */
export function toolNameOf(type: string, item: Record<string, unknown> | null): string {
  const i = item ?? {};
  switch (type) {
    case "dynamicToolCall":
      return [str(i.namespace), str(i.tool)].filter(Boolean).join(".") || "open-bot tool";
    case "mcpToolCall":
      return [str(i.server), str(i.tool)].filter(Boolean).join(".") || "MCP tool";
    case "collabAgentToolCall":
      return str(i.tool) ?? "Agent tool";
    default:
      return TOOL_KIND_NAMES[type] ?? type;
  }
}

const ERROR_STATUSES = ["failed", "declined", "error", "rejected", "cancelled"] as const;

/** Statuses that mean a tool item failed, as `outcomeOf` reads them. */
export const TOOL_ERROR_STATUSES: readonly string[] = ERROR_STATUSES;

/**
 * Whether a completed tool item failed: an error, `success: false`, a non-zero exit code, or a
 * failing status. The same rule as an outcome's `error` tone in the run inspector.
 */
export function toolItemFailed(item: Record<string, unknown> | null): boolean {
  if (!item) return false;
  const error = item.error;
  if (isRecord(error) || str(error)) return true;
  if (item.success === false) return true;
  if (typeof item.exitCode === "number" && Number.isFinite(item.exitCode) && item.exitCode !== 0)
    return true;
  return typeof item.status === "string" && TOOL_ERROR_STATUSES.includes(item.status);
}
