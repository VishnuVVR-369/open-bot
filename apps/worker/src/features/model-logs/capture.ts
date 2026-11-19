// Turns one finished proxied exchange into what the writer saves: the request row, its blobs
// (each input and output item, the instructions and the tool list), and the item order.
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { modelRequests } from "@open-bot/db";
import {
  type HeaderBag,
  type ModelItemSide,
  type ModelRoute,
  type ModelTransport,
  type RebuiltResponse,
  headerValue,
  rateLimitHeaders,
  requestCostMicros,
  sanitizeHeaders,
  splitRequestBody,
  turnMetadata,
} from "@open-bot/domain";
import { type ModelBlob, modelBlob } from "@open-bot/domain/server";

/** One request as the proxy saw it, from the first byte in to the last byte out. */
export interface Exchange {
  route: ModelRoute;
  transport: ModelTransport;
  method: string;
  /** The path under the route, with its query. */
  endpoint: string;
  teammateId: string | null;
  requestHeaders: HeaderBag;
  /** The body as sent (still compressed if it was), or null when it wasn't kept. */
  requestBody: Buffer | null;
  requestBytes: number;
  status: number | null;
  responseHeaders: HeaderBag | null;
  /** The rebuilt response, or null when the body wasn't read (a `models` list, a refusal). */
  response: RebuiltResponse | null;
  /** The start of the response as it came, kept in case it can't be rebuilt. */
  rawResponse: string | null;
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

/** The request row, blobs and items for an exchange. Never throws on what it can't read. */
export async function recordExchange(exchange: Exchange, id: string): Promise<ModelRequestRecord> {
  const warnings = [...exchange.warnings];
  let body: unknown = null;
  if (exchange.requestBody && exchange.requestBody.length) {
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
    items.push({ side: "input", position, blobHash: keep(modelBlob("item", item)) }),
  );
  const response = exchange.response;
  (response?.output ?? []).forEach((item, position) =>
    items.push({ side: "output", position, blobHash: keep(modelBlob("item", item)) }),
  );
  const instructionsHash =
    split.instructions !== null ? keep(modelBlob("instructions", split.instructions)) : null;
  const toolsHash = split.tools !== null ? keep(modelBlob("tools", split.tools)) : null;
  const usage = response?.usage ?? null;
  const error = exchange.failure ?? response?.error ?? null;
  // Kept only when the response couldn't be rebuilt, so what came back isn't lost.
  const rawResponse =
    response && (!response.parsed || (response.stream && !response.complete))
      ? exchange.rawResponse
      : null;
  const params = body === null ? null : split.params;
  const row: ModelRequestRecord["row"] = {
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
    model: response?.model ?? split.model,
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
    params,
    instructionsHash,
    toolsHash,
    responseText: response?.text || null,
    reasoningSummary: response?.reasoningSummary || null,
    rawResponse,
    requestBytes: exchange.requestBytes,
    responseBytes: exchange.responseBytes,
    parseWarnings: [...warnings, ...(response?.warnings ?? [])],
  };
  let bytes = 1024 + (rawResponse?.length ?? 0) + (params ? JSON.stringify(params).length : 0);
  for (const blob of blobs.values()) bytes += blob.content.length;
  bytes += (row.responseText?.length ?? 0) + (row.reasoningSummary?.length ?? 0);
  return { row, blobs: [...blobs.values()], items, bytes };
}
