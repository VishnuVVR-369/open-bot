// A Responses API request body taken apart for storage: the input items, instructions and tool
// list go to content-addressed blobs, everything else stays with the request as its parameters.
import { type HeaderBag, headerValue } from "./headers";

/** The Codex header with a JSON description of the turn a request belongs to. */
export const TURN_METADATA_HEADER = "x-codex-turn-metadata";

/** What a request says about the Codex thread and turn it belongs to. */
export interface TurnMetadata {
  threadId: string | null;
  turnId: string | null;
  /** `turn`, `prewarm`, `compaction` or `memory`, as Codex names it. */
  requestKind: string | null;
}

export interface SplitRequest {
  model: string | null;
  /** Everything but the parts below, as sent. */
  params: Record<string, unknown>;
  instructions: unknown;
  tools: unknown;
  /** The input items, in order; null when `input` was not a list (it then stays in `params`). */
  input: unknown[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseObject(value: string | undefined | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Splits a request body. `instructions` and `tools` are taken out only when they hold something,
 * so rebuilding the body from the parts gives back the same JSON value.
 */
export function splitRequestBody(body: unknown): SplitRequest {
  if (!isRecord(body))
    return { model: null, params: {}, instructions: null, tools: null, input: null };
  const { instructions, tools, input, ...rest } = body;
  const params: Record<string, unknown> = { ...rest };
  const present = (value: unknown) =>
    value !== undefined &&
    value !== null &&
    value !== "" &&
    !(Array.isArray(value) && value.length === 0);
  if (!present(instructions) && instructions !== undefined) params.instructions = instructions;
  if (!present(tools) && tools !== undefined) params.tools = tools;
  if (!Array.isArray(input) && input !== undefined) params.input = input;
  return {
    model: text(body.model),
    params,
    instructions: present(instructions) ? instructions : null,
    tools: present(tools) ? tools : null,
    input: Array.isArray(input) ? input : null,
  };
}

/** The body back from its parts, as `splitRequestBody` took it apart. */
export function joinRequestBody(parts: Omit<SplitRequest, "model">): Record<string, unknown> {
  return {
    ...parts.params,
    ...(parts.instructions !== null ? { instructions: parts.instructions } : {}),
    ...(parts.tools !== null ? { tools: parts.tools } : {}),
    ...(parts.input !== null ? { input: parts.input } : {}),
  };
}

/**
 * The thread, turn and kind of a Codex request: from the `x-codex-turn-metadata` header, else
 * the same JSON in the body's `client_metadata` (the only place it is over a WebSocket), else the
 * plain `thread_id` and `turn_id` there, else the `thread-id` header.
 */
export function turnMetadata(headers: HeaderBag, body: unknown): TurnMetadata {
  const clientMetadata =
    isRecord(body) && isRecord(body.client_metadata) ? body.client_metadata : {};
  const described =
    parseObject(headerValue(headers, TURN_METADATA_HEADER)) ??
    parseObject(text(clientMetadata[TURN_METADATA_HEADER])) ??
    {};
  return {
    threadId:
      text(described.thread_id) ??
      text(clientMetadata.thread_id) ??
      text(headerValue(headers, "thread-id")) ??
      null,
    turnId: text(described.turn_id) ?? text(clientMetadata.turn_id) ?? null,
    requestKind: text(described.request_kind),
  };
}
