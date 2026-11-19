// How a logged request's parts read: each input or output item labeled by what it is (your
// message, the model's answer, a tool call, a tool's output, a reasoning summary), the input
// rebuilt in order from its stored items, and the tool list by name. Pure, so the inspector shows
// the same thing the tests check.
import { z } from "zod";

/** What an item is, as the inspector labels it. */
export const MODEL_ITEM_KINDS = [
  "user",
  "assistant",
  "system",
  "tool_call",
  "tool_output",
  "reasoning",
  "other",
] as const;
export const modelItemKindSchema = z.enum(MODEL_ITEM_KINDS);
export type ModelItemKind = (typeof MODEL_ITEM_KINDS)[number];

/** One item described: its kind, a label, and its readable text. */
export interface DescribedItem {
  kind: ModelItemKind;
  /** Short and plain: `User`, `Assistant`, `Tool call: exec`, `Tool output`, ... */
  label: string;
  /** The text a person reads: a message's text, a call's arguments, an output, a summary. */
  text: string;
  /** The call it makes or answers, for tool calls and their outputs. */
  callId: string | null;
  /** The item's `type` as sent, like `function_call_output`. */
  type: string | null;
}

/** One item of a request's input, rebuilt in order. */
export interface RebuiltItem extends DescribedItem {
  position: number;
  /**
   * Whether the request itself sent it. Over a WebSocket, items before `sent_input_from` were not
   * sent again: they continue the previous response, and the proxy rebuilt them.
   */
  sent: boolean;
  /** The item as stored, as JSON text; null when its blob is gone. */
  json: string | null;
}

export interface RebuiltInput {
  items: RebuiltItem[];
  /** Positions with no stored item: a hole in the order, or an item whose blob is gone. */
  missing: number[];
}

/** One tool the request offered the model. */
export interface OfferedTool {
  name: string;
  type: string;
  description: string | null;
  /** The tool's definition as JSON text. */
  json: string;
}

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
  "web_search_call",
  "image_generation_call",
  "mcp_call",
  "computer_call",
]);

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
  "tool_search_output",
  "computer_call_output",
  "mcp_list_tools",
  "mcp_approval_response",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A value as text: a string as it is, anything else as JSON. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** The text of a content list: each text part, and a note for each image or file. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return asText(content);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (!isRecord(part)) continue;
    else if (typeof part.text === "string") parts.push(part.text);
    else if (typeof part.refusal === "string") parts.push(`Refused: ${part.refusal}`);
    else if (part.type === "input_image" || part.type === "image_url") parts.push("[image]");
    else if (part.type === "input_file")
      parts.push(`[file${str(part.filename) ? ` ${String(part.filename)}` : ""}]`);
    else if (part.type === "input_audio") parts.push("[audio]");
  }
  return parts.join("\n\n");
}

function roleKind(role: unknown): { kind: ModelItemKind; label: string } {
  switch (role) {
    case "user":
      return { kind: "user", label: "User" };
    case "assistant":
      return { kind: "assistant", label: "Assistant" };
    case "developer":
      return { kind: "system", label: "Developer" };
    case "system":
      return { kind: "system", label: "System" };
    case "tool":
      return { kind: "tool_output", label: "Tool output" };
    default:
      return { kind: "other", label: str(role) ?? "Message" };
  }
}

/** What a tool call passed: its arguments, a custom tool's input, or its action. */
function callArguments(item: Record<string, unknown>): string {
  if (item.type === "custom_tool_call") return asText(item.input);
  if (item.arguments !== undefined) {
    // Function arguments are a JSON string; show them laid out when they parse.
    if (typeof item.arguments === "string") {
      try {
        return JSON.stringify(JSON.parse(item.arguments), null, 2);
      } catch {
        return item.arguments;
      }
    }
    return asText(item.arguments);
  }
  return asText(item.action ?? item.query ?? "");
}

/**
 * Describes one input or output item of a Responses request (or a memory AI request's message or
 * embedded text), never failing on a shape it doesn't know.
 */
export function describeItem(item: unknown): DescribedItem {
  if (typeof item === "string")
    return { kind: "other", label: "Text", text: item, callId: null, type: null };
  if (!isRecord(item))
    return { kind: "other", label: "Value", text: asText(item), callId: null, type: null };
  const type = str(item.type);
  const callId = str(item.call_id);
  if (type === "message" || (type === null && item.role !== undefined)) {
    const { kind, label } = roleKind(item.role);
    return { kind, label, text: contentText(item.content), callId, type };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary) ? contentText(item.summary) : "";
    const encrypted = typeof item.encrypted_content === "string";
    return {
      kind: "reasoning",
      label: "Reasoning summary",
      text: summary || (encrypted ? "Encrypted reasoning, no summary." : ""),
      callId: null,
      type,
    };
  }
  if (type !== null && TOOL_CALL_TYPES.has(type)) {
    const name = str(item.name) ?? type.replace(/_call$/, "");
    const namespace = str(item.namespace) ?? str(item.server_label);
    return {
      kind: "tool_call",
      label: `Tool call: ${namespace ? `${namespace}.` : ""}${name}`,
      text: callArguments(item),
      callId: callId ?? str(item.id),
      type,
    };
  }
  if (type !== null && TOOL_OUTPUT_TYPES.has(type))
    return {
      kind: "tool_output",
      label: "Tool output",
      text: contentText(item.output ?? item.tools ?? item.content),
      callId,
      type,
    };
  if (type === "compaction" || type === "compaction_summary")
    return {
      kind: "other",
      label: "Compacted history",
      text: typeof item.encrypted_content === "string" ? "Encrypted." : asText(item.summary),
      callId: null,
      type,
    };
  return { kind: "other", label: type ?? "Item", text: asText(item), callId, type };
}

/**
 * A request's input back in order from its stored items. `rows` are its `input` items with their
 * blob's content (null when the blob is gone); `sentInputFrom` is where the items the request
 * itself sent begin, or null when it sent them all.
 */
export function rebuildInput(
  rows: readonly { position: number; content: string | null }[],
  sentInputFrom: number | null,
): RebuiltInput {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const items: RebuiltItem[] = [];
  const missing: number[] = [];
  let expected = 0;
  for (const row of ordered) {
    for (; expected < row.position; expected++) missing.push(expected);
    expected = row.position + 1;
    const sent = sentInputFrom === null || row.position >= sentInputFrom;
    if (row.content === null) {
      missing.push(row.position);
      continue;
    }
    let described: DescribedItem;
    try {
      described = describeItem(JSON.parse(row.content));
    } catch {
      described = {
        kind: "other",
        label: "Unreadable item",
        text: row.content,
        callId: null,
        type: null,
      };
    }
    items.push({ ...described, position: row.position, sent, json: row.content });
  }
  return { items, missing };
}

/** The tools a request offered, by name, from its stored tool list. */
export function offeredTools(json: string | null): OfferedTool[] {
  if (!json) return [];
  let tools: unknown;
  try {
    tools = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const record = isRecord(tool) ? tool : {};
    const type = str(record.type) ?? "tool";
    return {
      name: str(record.name) ?? str(record.server_label) ?? type,
      type,
      description: str(record.description),
      json: JSON.stringify(tool, null, 2),
    };
  });
}

/** Instructions as text: a string as it is, anything else as JSON. */
export function instructionsText(json: string | null): string | null {
  if (!json) return null;
  try {
    return asText(JSON.parse(json));
  } catch {
    return json;
  }
}
