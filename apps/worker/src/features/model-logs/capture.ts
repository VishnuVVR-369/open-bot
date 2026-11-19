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
  type InputSize,
  type RebuiltResponse,
  type ResponseUsage,
  MAX_JSON_DEPTH,
  estimateUsage,
  headerValue,
  inputSizeOf,
  nestedDeeperThan,
  outputBytesOf,
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
  /**
   * The request reached the upstream: over HTTP a model request (a POST) whose connection was
   * open, over a WebSocket a `response.create` message, relayed as it came. Only such a request
   * can have cost anything.
   */
  sent: boolean;
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

const SYNC_DECODERS: Record<string, (body: Buffer) => Buffer> = {
  gzip: zlib.gunzipSync,
  "x-gzip": zlib.gunzipSync,
  deflate: zlib.inflateSync,
  br: zlib.brotliDecompressSync,
  zstd: zlib.zstdDecompressSync,
};

/** The `content-encoding` codings that change a body, in the order they come off. */
function codingsOf(encoding: string | undefined): string[] {
  return (encoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity")
    .reverse();
}

/** A body without its `content-encoding`, or null when it uses one Node can't undo. */
export async function decodeBody(
  body: Buffer,
  encoding: string | undefined,
): Promise<Buffer | null> {
  let decoded = body;
  // Codings apply in the order listed, so they come off in reverse.
  for (const coding of codingsOf(encoding)) {
    const decode = DECODERS[coding];
    if (!decode) return null;
    decoded = await decode(decoded);
  }
  return decoded;
}

/** `decodeBody`, at once: null when a coding is unknown or the body doesn't decode. */
function decodeBodySync(body: Buffer, encoding: string | undefined): Buffer | null {
  let decoded = body;
  try {
    for (const coding of codingsOf(encoding)) {
      const decode = SYNC_DECODERS[coding];
      if (!decode) return null;
      decoded = decode(decoded);
    }
  } catch {
    return null;
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

/**
 * Whether the upstream may have charged for an API key request: it reached the upstream and was
 * answered with success, or not answered at all (cut off, cancelled, still running). An error
 * answer (a refusal, a rate limit) is charged only for what the model wrote before it.
 */
function mayHaveCost(exchange: Exchange): boolean {
  if (exchange.route !== "api" || !exchange.sent) return false;
  // Over HTTP the upstream's status line (a 502 the proxy made up has no headers), over a
  // WebSocket the status of an error event that ended the response.
  const answered =
    exchange.transport === "http"
      ? exchange.responseHeaders
        ? exchange.status
        : null
      : exchange.status;
  if (answered === null || (answered >= 200 && answered < 300)) return true;
  return outputBytesOf(exchange.response) > 0;
}

/** The request's input, for an estimate, or null when its size can't be known. */
function inputOf(exchange: Exchange): InputSize | null {
  // Over a WebSocket, the input rebuilt from the connection, which is what the API reads.
  const rebuilt = exchange.sentInputFrom !== null && exchange.sentInputFrom !== undefined;
  if (exchange.requestJson !== undefined && exchange.requestJson !== null)
    return inputSizeOf(exchange.requestJson, rebuilt);
  const encoding = headerValue(exchange.requestHeaders, "content-encoding");
  if (exchange.requestBody) {
    const decoded = decodeBodySync(exchange.requestBody, encoding);
    if (!decoded) return null;
    try {
      return inputSizeOf(JSON.parse(decoded.toString("utf8")), false);
    } catch {
      return { bytes: decoded.length, images: 0 };
    }
  }
  // Too large to keep: its size as sent is its size only when it wasn't compressed.
  if (exchange.transport === "http" && codingsOf(encoding).length) return null;
  return { bytes: exchange.requestBytes, images: 0 };
}

/** What a request's row and the cap count as its usage, and whether that is an estimate. */
export interface CountedUsage {
  usage: ResponseUsage | null;
  estimated: boolean;
}

/**
 * A request's usage as the API reported it, or, for an API key request that may have cost money
 * without reporting it, an estimate that errs high (`estimateUsage`): never a known zero. `end`
 * is when it ended, or now for one still running.
 */
export function countedUsage(exchange: Exchange, end: Date): CountedUsage {
  const usage = exchange.response?.usage ?? null;
  if (usage || !mayHaveCost(exchange)) return { usage, estimated: false };
  return {
    usage: estimateUsage({
      input: inputOf(exchange),
      outputBytes: outputBytesOf(exchange.response),
      elapsedMs: end.getTime() - exchange.startedAt.getTime(),
    }),
    estimated: true,
  };
}

/** A model request lost before it was logged: its route, and what it cost (maybe estimated). */
export interface LostRequest {
  startedAt: Date;
  route: ModelRoute | null;
  costMicros: number;
  estimated: boolean;
}

/**
 * What a gap keeps of an exchange that couldn't be logged: priced as its row would have been,
 * from its usage or an estimate. `end` is when it ended, or now for one still running.
 */
export function lostRequestOf(exchange: Exchange, end: Date): LostRequest {
  const counted = countedUsage(exchange, end);
  return {
    startedAt: exchange.startedAt,
    route: exchange.route,
    costMicros: requestCostMicros(exchange.route, counted.usage),
    estimated: counted.estimated,
  };
}

/** The fields of a request row that come from the exchange alone, not from reading its bodies. */
function rowOf(
  exchange: Exchange,
  id: string,
  metadata: ReturnType<typeof turnMetadata>,
  warnings: string[],
): ModelRequestRecord["row"] {
  const response = exchange.response;
  const { usage, estimated } = countedUsage(exchange, exchange.endedAt);
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
    // An estimate counts reasoning as output, which it is billed as.
    reasoningTokens: estimated ? null : (usage?.reasoningTokens ?? null),
    costMicros: requestCostMicros(exchange.route, usage),
    usageEstimated: estimated,
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
    parseWarnings: [
      ...warnings,
      ...(response?.warnings ?? []),
      ...(estimated
        ? ["the API reported no usage, so its tokens and cost are an estimate that errs high"]
        : []),
    ],
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
