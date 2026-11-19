// The memory AI's calls as model requests (`source = memory`): the worker hands `MemoryAI` an
// observer that queues each embedding and extraction call on the writer. The observer never sees
// the API key, so it can't be stored.
import { randomUUID } from "node:crypto";
import type { ResponseUsage } from "@open-bot/domain";
import { modelBlob, type ModelBlob } from "@open-bot/domain/server";
import type { MemoryAIObserver, MemoryAIRequest } from "@open-bot/memory/jobs";
import type { ModelRequestRecord } from "./capture";
import { RAW_RESPONSE_LIMIT } from "./response-tap";
import type { ModelLogWriter } from "./writer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Usage as chat completions and embeddings report it (`prompt_tokens`, ...), when given. */
export function chatUsage(value: unknown): ResponseUsage | null {
  if (!isRecord(value)) return null;
  const input = count(value.prompt_tokens);
  const output = count(value.completion_tokens);
  if (input === null && output === null) return null;
  const prompt = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const completion = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : {};
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: count(prompt.cached_tokens) ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: count(completion.reasoning_tokens) ?? 0,
  };
}

/** The address without what could carry a secret: no user, password, query or fragment. */
function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unreadable URL)";
  }
}

/** An OpenAI-style error envelope's fields (`{"error": {"code", "type", "message"}}`), if any. */
function errorOf(answer: Record<string, unknown>): { type: string | null; message: string | null } {
  const error = answer.error;
  if (typeof error === "string") return { type: null, message: error };
  if (!isRecord(error)) return { type: null, message: null };
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return { type: text(error.code) ?? text(error.type), message: text(error.message) };
}

/**
 * One memory AI call as a request row: the messages (or the text embedded) as input items, the
 * rest of the body as params, the answer (choices or embeddings) as output items.
 */
export function memoryRecord(call: MemoryAIRequest, id: string): ModelRequestRecord {
  const body = isRecord(call.body) ? call.body : {};
  const { messages, input, ...params } = body;
  const sent: unknown[] = Array.isArray(messages)
    ? messages
    : input === undefined
      ? []
      : Array.isArray(input)
        ? input
        : [input];
  let parsed: unknown = null;
  const warnings: string[] = [];
  if (call.response !== null)
    try {
      parsed = JSON.parse(call.response);
    } catch {
      warnings.push("the response was not JSON");
    }
  const answer = isRecord(parsed) ? parsed : {};
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const received: unknown[] = choices.length
    ? choices.map((choice) => (isRecord(choice) ? (choice.message ?? choice) : choice))
    : Array.isArray(answer.data)
      ? answer.data
      : [];
  const blobs = new Map<string, ModelBlob>();
  const items: ModelRequestRecord["items"] = [];
  const keep = (side: "input" | "output", item: unknown, position: number) => {
    const blob = modelBlob("item", item);
    blobs.set(blob.hash, blob);
    items.push({ side, position, blobHash: blob.hash });
  };
  sent.forEach((item, position) => keep("input", item, position));
  received.forEach((item, position) => keep("output", item, position));
  const text = choices
    .map((choice) =>
      isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string"
        ? choice.message.content
        : "",
    )
    .filter(Boolean)
    .join("\n\n");
  const usage = chatUsage(answer.usage);
  const error = errorOf(answer);
  // Kept whenever the answer isn't one read above (choices, embeddings, or an error envelope with
  // a message), like a gateway's own JSON or an `error` object in another shape, and cut to the
  // same size as a model response's raw start.
  const understood = choices.length > 0 || Array.isArray(answer.data) || error.message !== null;
  const rawResponse =
    call.response !== null && !understood ? call.response.slice(0, RAW_RESPONSE_LIMIT) : null;
  if (rawResponse !== null && rawResponse.length < (call.response?.length ?? 0))
    warnings.push("the raw response was cut to fit");
  const failed = call.error !== null || error.message !== null || error.type !== null;
  const row: ModelRequestRecord["row"] = {
    id,
    source: "memory",
    route: null,
    transport: "http",
    method: "POST",
    endpoint: endpointOf(call.url),
    requestKind: call.kind,
    model: (typeof answer.model === "string" && answer.model) || (body.model as string) || null,
    status: call.status,
    startedAt: call.startedAt,
    firstByteAt: call.firstByteAt,
    endedAt: call.endedAt,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    stopReason: failed ? "failed" : "completed",
    errorType: failed ? (error.type ?? "memory_ai") : null,
    errorMessage: failed ? (error.message ?? call.error) : null,
    // Only what the memory AI always sends; its authorization is never given to the observer.
    requestHeaders: { "content-type": "application/json" },
    params,
    responseText: text || null,
    rawResponse,
    requestBytes: JSON.stringify(call.body ?? null).length,
    responseBytes: call.response?.length ?? 0,
    parseWarnings: warnings,
  };
  let bytes = 1024 + (rawResponse?.length ?? 0) + text.length;
  for (const blob of blobs.values()) bytes += blob.content.length;
  return { row, blobs: [...blobs.values()], items, toolCalls: [], bytes };
}

/** The observer the worker gives `MemoryAI`: each call is queued on the writer. */
export function memoryRequestObserver(writer: Pick<ModelLogWriter, "add">): MemoryAIObserver {
  return (call) => writer.add(memoryRecord(call, randomUUID()));
}
