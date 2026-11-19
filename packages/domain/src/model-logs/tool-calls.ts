// The tool calls a model made, read from the output items of its response.

/** One tool call in a response's output, as the model sent it. */
export interface ModelToolCall {
  /** The item's place in the response's output. */
  position: number;
  /**
   * The id the call's result is sent back under. Codex names the app-server item for the call
   * the same way, so this is how a call is joined to its outcome. For a web search, which has no
   * call id, the item's own id, which Codex also uses as the item id.
   */
  callId: string | null;
  /** The output item's type, like `function_call` or `custom_tool_call`. */
  type: string;
  name: string;
  namespace: string | null;
  /**
   * What the model passed, as text: a function's JSON arguments string, a custom tool's input,
   * or the action of a shell call or web search as JSON.
   */
  arguments: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The output item types that are tool calls, with the name a call of that type goes by when the
 * item doesn't name it.
 */
const CALL_TYPES: Record<string, string> = {
  function_call: "function",
  custom_tool_call: "custom",
  local_shell_call: "local_shell",
  tool_search_call: "tool_search",
  web_search_call: "web_search",
  image_generation_call: "image_generation",
  mcp_call: "mcp",
  computer_call: "computer",
};

/** Where each type keeps what the model passed. */
function argumentsOf(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "function_call":
    case "tool_search_call":
    case "mcp_call":
      return text(item.arguments);
    case "custom_tool_call":
      return text(item.input);
    case "image_generation_call":
      return null;
    default:
      return text(item.action);
  }
}

/** The tool calls among a response's output items, in order. */
export function toolCallsOf(output: readonly unknown[]): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  output.forEach((item, position) => {
    if (!isRecord(item) || typeof item.type !== "string") return;
    const fallback = CALL_TYPES[item.type];
    if (fallback === undefined) return;
    calls.push({
      position,
      callId: str(item.call_id) ?? str(item.id),
      type: item.type,
      name: str(item.name) ?? fallback,
      namespace: str(item.namespace) ?? str(item.server_label),
      arguments: argumentsOf(item),
    });
  });
  return calls;
}
