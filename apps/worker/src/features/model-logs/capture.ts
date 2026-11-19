// Turns one finished proxied exchange into what the writer saves: the request row, its blobs
// (each input and output item, the instructions and the tool list), and the item order.
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { modelRequests, modelToolCalls } from "@open-bot/db";
import {
  type HeaderBag,
  type ModelItemSide,
  type ModelRoute,
  type ModelTransport,
  type RebuiltResponse,
  MAX_JSON_DEPTH,
  headerValue,
  nestedDeeperThan,
  rateLimitHeaders,
  redactRawResponse,
  requestCostMicros,
  sanitizeHeaders,
  splitRequestBody,
  toolCallsOf,
  turnMetadata,
} from "@open-bot/domain";
import { type ModelBlob, modelBlob } from "@open-bot/domain/server";

/** One request as the proxy saw it, from the first byte in to the last byte out. */
export interface Exchange {
  route: ModelRoute;
  transport: ModelTransport;
  /** The HTTP method, or over a WebSocket the message type (`response.create`). */
  method: string;
  /** The path under the route, with its query. */
  endpoint: string;
  teammateId: string | null;
  requestHeaders: HeaderBag;
  /** The body as sent (still compressed if it was), or null when it wasn't kept. */
  requestBody: Buffer | null;
  /**
   * The body already read, which takes the place of `requestBody`: over a WebSocket, the
   * message with its full input rebuilt.
   */
  requestJson?: unknown;
  /** How many items at the start of the input the message didn't send (see `sentInputFrom`). */
  sentInputFrom?: number | null;
  requestBytes: number;
  status: number | null;
  responseHeaders: HeaderBag | null;
  /** The rebuilt response, or null when the body wasn't read (a `models` list, a refusal). */
  response: RebuiltResponse | null;
  /**
   * The start of the response as it came, kept in case it can't be rebuilt: an HTTP body, or over
   * a WebSocket its messages, so each is redacted on its own (`redactRawResponse`).
   */
  rawResponse: string | readonly string[] | null;
  responseBytes: number;
  startedAt: Date;
  firstByteAt: Date | null;
  endedAt: Date;
  /** Why the exchange failed on the proxy's side (upstream unreachable, client gone, ...). */
  failure: { type: string; message: string } | null;
  warnings: string[];
}

/** What the writer saves for one request. */
export interface ModelRequestRecord {
  row: typeof modelRequests.$inferInsert & { id: string };
  blobs: ModelBlob[];
  items: { side: ModelItemSide; position: number; blobHash: string }[];
  /** The tool calls among the response's output items. */
  toolCalls: Omit<typeof modelToolCalls.$inferInsert, "requestId">[];
  /** Roughly what it holds in memory, for the writer's cap. */
  bytes: number;
}

const DECODERS: Record<string, (body: Buffer) => Promise<Buffer>> = {
  gzip: promisify(zlib.gunzip),
  "x-gzip": promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
  zstd: promisify(zlib.zstdDecompress),
};

/** A body without its `content-encoding`, or null when it uses one Node can't undo. */
export async function decodeBody(
  body: Buffer,
  encoding: string | undefined,
): Promise<Buffer | null> {
  const codings = (encoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity");
  let decoded = body;
  // Codings apply in the order listed, so they come off in reverse.
  for (const coding of codings.reverse()) {
    const decode = DECODERS[coding];
    if (!decode) return null;
    decoded = await decode(decoded);
  }
  return decoded;
}

/**
 * Blobs of items already seen, by the item itself. A WebSocket connection rebuilds each request's
 * input from the same item objects as the one before, so only its new items are hashed. Items are
 * parsed JSON that nothing changes afterwards.
 */
const itemBlobs = new WeakMap<object, ModelBlob>();

function itemBlob(item: unknown): ModelBlob {
  if (typeof item !== "object" || item === null) return modelBlob("item", item);
  let blob = itemBlobs.get(item);
  if (!blob) itemBlobs.set(item, (blob = modelBlob("item", item)));
  return blob;
}

/** Why a request was logged without its bodies. */
export function notLoggedInFull(error: unknown): string {
  return `the request could not be logged in full: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * The request row, blobs and items for an exchange. What can't be read only costs its part of the
 * log, and should putting the record together fail all the same, the request is still logged:
 * without its bodies, with a warning that says why (`basicRecord`).
 */
export async function recordExchange(exchange: Exchange, id: string): Promise<ModelRequestRecord> {
  try {
    return await fullRecord(exchange, id);
  } catch (error) {
    return basicRecord(exchange, id, notLoggedInFull(error));
  }
}

/** The fields of a request row that come from the exchange alone, not from reading its bodies. */
function rowOf(
  exchange: Exchange,
  id: string,
  metadata: ReturnType<typeof turnMetadata>,
  warnings: string[],
): ModelRequestRecord["row"] {
  const response = exchange.response;
  const usage = response?.usage ?? null;
  const error = exchange.failure ?? response?.error ?? null;
  return {
    id,
    source: "codex",
    route: exchange.route,
    transport: exchange.transport,
    method: exchange.method,
    endpoint: exchange.endpoint,
    codexThreadId: metadata.threadId,
    codexTurnId: metadata.turnId,
    requestKind: metadata.requestKind,
    teammateId: exchange.teammateId,
    model: response?.model ?? null,
    responseId: response?.responseId ?? null,
    status: exchange.status,
    startedAt: exchange.startedAt,
    firstByteAt: exchange.firstByteAt,
    endedAt: exchange.endedAt,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    costMicros: requestCostMicros(exchange.route, usage),
    stopReason: response?.stopReason ?? null,
    errorType: error?.type ?? null,
    errorMessage: error?.message ?? null,
    requestHeaders: sanitizeHeaders(exchange.requestHeaders),
    responseHeaders: exchange.responseHeaders ? sanitizeHeaders(exchange.responseHeaders) : null,
    rateLimitHeaders: exchange.responseHeaders ? rateLimitHeaders(exchange.responseHeaders) : null,
    params: null,
    sentInputFrom: null,
    instructionsHash: null,
    toolsHash: null,
    responseText: null,
    reasoningSummary: null,
    rawResponse: null,
    requestBytes: exchange.requestBytes,
    responseBytes: exchange.responseBytes,
    parseWarnings: [...warnings, ...(response?.warnings ?? [])],
  };
}

/**
 * The request logged without its bodies (no input, output, parameters or raw response): what is
 * left when they couldn't be put together. Its thread is read from the headers alone.
 */
function basicRecord(exchange: Exchange, id: string, warning: string): ModelRequestRecord {
  const metadata = turnMetadata(exchange.requestHeaders, exchange.requestJson ?? null);
  const row = rowOf(exchange, id, metadata, [...exchange.warnings, warning]);
  return { row, blobs: [], items: [], toolCalls: [], bytes: 1024 };
}

async function fullRecord(exchange: Exchange, id: string): Promise<ModelRequestRecord> {
  const warnings = [...exchange.warnings];
  let body: unknown = exchange.requestJson ?? null;
  if (exchange.requestJson === undefined && exchange.requestBody && exchange.requestBody.length) {
    try {
      const decoded = await decodeBody(
        exchange.requestBody,
        headerValue(exchange.requestHeaders, "content-encoding"),
      );
      if (decoded) body = JSON.parse(decoded.toString("utf8"));
      else warnings.push("the request body used an encoding the proxy can't read");
    } catch {
      warnings.push("the request body was not JSON");
    }
  }
  const split = splitRequestBody(body);
  const metadata = turnMetadata(exchange.requestHeaders, body);
  const blobs = new Map<string, ModelBlob>();
  const keep = (blob: ModelBlob) => {
    blobs.set(blob.hash, blob);
    return blob.hash;
  };
  const items: ModelRequestRecord["items"] = [];
  (split.input ?? []).forEach((item, position) =>
    items.push({ side: "input", position, blobHash: keep(itemBlob(item)) }),
  );
  const response = exchange.response;
  (response?.output ?? []).forEach((item, position) =>
    items.push({ side: "output", position, blobHash: keep(itemBlob(item)) }),
  );
  const instructionsHash =
    split.instructions !== null ? keep(modelBlob("instructions", split.instructions)) : null;
  const toolsHash = split.tools !== null ? keep(modelBlob("tools", split.tools)) : null;
  // Kept only when the response couldn't be rebuilt, so what came back isn't lost, without the
  // credentials that header objects in its events or error envelope may carry.
  let rawResponse: string | null = null;
  if (
    response &&
    (!response.parsed || (response.stream && !response.complete)) &&
    exchange.rawResponse
  ) {
    const contentType = exchange.responseHeaders
      ? (headerValue(exchange.responseHeaders, "content-type") ?? null)
      : null;
    const redacted = redactRawResponse(exchange.rawResponse, contentType);
    rawResponse = redacted.text || null;
    if (redacted.cut)
      warnings.push("the raw response was cut where a header object in it could not be read");
  }
  let params = body === null ? null : split.params;
  // Stored as JSON, it is serialized as a whole: too deep, that would throw.
  if (params && nestedDeeperThan(params, MAX_JSON_DEPTH)) {
    params = null;
    warnings.push("the request's parameters were nested too deeply to keep");
  }
  const row: ModelRequestRecord["row"] = {
    ...rowOf(exchange, id, metadata, warnings),
    model: response?.model ?? split.model,
    params,
    sentInputFrom: exchange.sentInputFrom ?? null,
    instructionsHash,
    toolsHash,
    responseText: response?.text || null,
    reasoningSummary: response?.reasoningSummary || null,
    rawResponse,
  };
  const toolCalls = toolCallsOf(response?.output ?? []);
  let bytes = 1024 + (rawResponse?.length ?? 0) + (params ? JSON.stringify(params).length : 0);
  for (const blob of blobs.values()) bytes += blob.content.length;
  bytes += (row.responseText?.length ?? 0) + (row.reasoningSummary?.length ?? 0);
  for (const call of toolCalls) bytes += 128 + (call.arguments?.length ?? 0);
  return { row, blobs: [...blobs.values()], items, toolCalls, bytes };
}
