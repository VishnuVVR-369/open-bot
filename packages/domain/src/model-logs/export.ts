// A model request rebuilt in full for the JSONL export: the body as it was sent, the response,
// and everything known about it, one JSON object per line.
import { expiredParams } from "./retention";

/** A stored blob's value; text that isn't JSON (never written by the proxy) is kept as text. */
export function parseBlob(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Where a request's input items go back in its body, by the API it called:
 * - `responses`: `input`, a list (a Responses input that wasn't a list stayed in the parameters);
 * - `messages`: `messages`, for chat completions (memory extraction);
 * - `embedding`: `input`, a single string when one string was sent (memory sends one).
 */
export type RequestShape = "responses" | "messages" | "embedding";

/** A request's shape, from the endpoint it called and, for memory, what it did. */
export function requestShape(parts: {
  source: string;
  requestKind: string | null;
  endpoint: string;
}): RequestShape {
  const path = parts.endpoint.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const memory = parts.source === "memory";
  if (path.endsWith("/chat/completions") || (memory && parts.requestKind === "extraction"))
    return "messages";
  if (path.endsWith("/embeddings") || (memory && parts.requestKind === "embedding"))
    return "embedding";
  return "responses";
}

/**
 * The request body as it was sent, in the shape of the API it called: its parameters, then the
 * instructions and tools when it had them, then its input items under the field they came in.
 * Over a WebSocket the input is the full input the model saw; the message itself sent the items
 * from `sent_input_from` on. Null when nothing of the body was stored (it wasn't JSON).
 *
 * Two cases come back slightly different from what was sent, since storage can't tell them
 * apart: an empty input list is left out, and an embedding of a one-string list comes back as
 * that string (the same request to the embeddings API; memory only ever sends a string).
 */
export function rebuildRequestBody(parts: {
  source: string;
  requestKind: string | null;
  endpoint: string;
  params: Record<string, unknown> | null;
  instructions: string | null;
  tools: string | null;
  input: readonly (string | null)[];
}): Record<string, unknown> | null {
  if (
    parts.params === null &&
    parts.instructions === null &&
    parts.tools === null &&
    !parts.input.length
  )
    return null;
  const params = parts.params ?? {};
  const body: Record<string, unknown> = {
    ...params,
    ...(parts.instructions !== null ? { instructions: parseBlob(parts.instructions) } : {}),
    ...(parts.tools !== null ? { tools: parseBlob(parts.tools) } : {}),
  };
  if (!parts.input.length) return body;
  const items = parts.input.map(parseBlob);
  const shape = requestShape(parts);
  if (shape === "messages") return { ...body, messages: items };
  if (shape === "embedding")
    return {
      ...body,
      input: items.length === 1 && typeof items[0] === "string" ? items[0] : items,
    };
  // A Responses input that wasn't a list stayed in the parameters, and is never replaced.
  if (Object.hasOwn(params, "input")) return body;
  return { ...body, input: items };
}

/** What the export knows about one request besides its bodies. */
export interface ExportedRequestRow {
  id: string;
  runId: string | null;
  source: string;
  route: string | null;
  transport: string;
  method: string;
  endpoint: string;
  teammateId: string | null;
  codexThreadId: string | null;
  codexTurnId: string | null;
  requestKind: string | null;
  model: string | null;
  responseId: string | null;
  status: number | null;
  startedAt: string;
  firstByteAt: string | null;
  endedAt: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costMicros: number;
  stopReason: string | null;
  errorType: string | null;
  errorMessage: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string> | null;
  rateLimitHeaders: Record<string, string> | null;
  params: Record<string, unknown> | null;
  sentInputFrom: number | null;
  responseText: string | null;
  reasoningSummary: string | null;
  rawResponse: string | null;
  parseWarnings: string[];
  bodiesExpiredAt: string | null;
}

/** One line of the export, without its newline. */
export function exportLine(
  row: ExportedRequestRow,
  bodies: {
    instructions: string | null;
    tools: string | null;
    input: readonly (string | null)[];
    output: readonly (string | null)[];
    toolCalls: readonly {
      callId: string | null;
      type: string;
      name: string;
      arguments: string | null;
    }[];
  },
): string {
  const expired = row.bodiesExpiredAt !== null;
  return JSON.stringify({
    id: row.id,
    run_id: row.runId,
    source: row.source,
    route: row.route,
    transport: row.transport,
    method: row.method,
    endpoint: row.endpoint,
    teammate_id: row.teammateId,
    codex_thread_id: row.codexThreadId,
    codex_turn_id: row.codexTurnId,
    request_kind: row.requestKind,
    model: row.model,
    status: row.status,
    started_at: row.startedAt,
    first_byte_at: row.firstByteAt,
    ended_at: row.endedAt,
    usage: {
      input_tokens: row.inputTokens,
      cached_input_tokens: row.cachedInputTokens,
      output_tokens: row.outputTokens,
      reasoning_tokens: row.reasoningTokens,
    },
    cost_micros: row.costMicros,
    stop_reason: row.stopReason,
    error:
      row.errorType !== null || row.errorMessage !== null
        ? { type: row.errorType, message: row.errorMessage }
        : null,
    request_headers: row.requestHeaders,
    response_headers: row.responseHeaders,
    rate_limit_headers: row.rateLimitHeaders,
    // An expired request keeps only how it was asked (see `expiredParams`), never what it said.
    params: expired ? expiredParams(row.params) : row.params,
    sent_input_from: row.sentInputFrom,
    parse_warnings: row.parseWarnings,
    bodies_expired_at: row.bodiesExpiredAt,
    // After the bodies expired there is nothing left to rebuild the request from.
    request: expired
      ? null
      : rebuildRequestBody({
          source: row.source,
          requestKind: row.requestKind,
          endpoint: row.endpoint,
          params: row.params,
          instructions: bodies.instructions,
          tools: bodies.tools,
          input: bodies.input,
        }),
    response: expired
      ? null
      : {
          id: row.responseId,
          output: bodies.output.map(parseBlob),
          output_text: row.responseText,
          reasoning_summary: row.reasoningSummary,
          raw_response: row.rawResponse,
        },
    tool_calls: bodies.toolCalls.map((call) => ({
      call_id: call.callId,
      type: call.type,
      name: call.name,
      arguments: expired ? null : call.arguments,
    })),
  });
}
