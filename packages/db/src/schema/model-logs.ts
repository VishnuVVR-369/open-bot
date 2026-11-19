// Model logs: every model request the model proxy forwards, its parts stored once by hash, and
// the batches the writer had to drop. Requests link to runs through Codex's thread and turn ids,
// joined when read, never resolved when written.
import {
  MODEL_BLOB_KINDS,
  MODEL_ITEM_SIDES,
  MODEL_REQUEST_SOURCES,
  MODEL_ROUTES,
  MODEL_TRANSPORTS,
  type ModelBlobKind,
  type ModelItemSide,
  type ModelRequestSource,
  type ModelRoute,
  type ModelTransport,
} from "@open-bot/domain";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf } from "./columns";
import { bots } from "./teammates"; // vocabulary: allow

/**
 * A distinct input or output item, instructions or tool list, stored once under its SHA-256.
 * Almost every request sends the same history again, so this is where the space goes; the
 * migration sets lz4 compression on `content` where the server supports it.
 */
export const modelBlobs = pgTable(
  "model_blobs",
  {
    hash: text("hash").primaryKey(),
    kind: text("kind").$type<ModelBlobKind>().notNull(),
    /** The value as JSON, exactly as it is rebuilt. */
    content: text("content").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (table) => [check("model_blobs_kind_check", oneOf(table.kind, MODEL_BLOB_KINDS))],
);

/** One model request: who made it, how it went, and the parts of it that aren't blobs. */
export const modelRequests = pgTable(
  "model_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").$type<ModelRequestSource>().notNull(),
    /** The proxy route it took; null for a request that didn't go through the proxy. */
    route: text("route").$type<ModelRoute>(),
    transport: text("transport").$type<ModelTransport>().notNull(),
    method: text("method").notNull(),
    /** The path under the route, like `/responses`. */
    endpoint: text("endpoint").notNull(),
    /** From the request's turn metadata. Runs are found through these when the logs are read. */
    codexThreadId: text("codex_thread_id"),
    codexTurnId: text("codex_turn_id"),
    /** `turn`, `prewarm`, `compaction` or `memory`, as Codex names it. */
    requestKind: text("request_kind"),
    /** The teammate whose live run the request was made for, when the proxy knew it. */
    teammateId: uuid("teammate_id").references(() => bots.id, { onDelete: "set null" }), // vocabulary: allow
    model: text("model"),
    responseId: text("response_id"),
    /** The HTTP status the client got; null when it never got one. */
    status: integer("status"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    firstByteAt: timestamp("first_byte_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }),
    /** Millionths of a dollar: list prices on the API key, zero on the plan. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** `completed`, `failed`, or `incomplete:<reason>`. */
    stopReason: text("stop_reason"),
    errorType: text("error_type"),
    errorMessage: text("error_message"),
    /** Headers without credentials (`sanitizeHeaders`). */
    requestHeaders: jsonb("request_headers").$type<Record<string, string>>().notNull(),
    responseHeaders: jsonb("response_headers").$type<Record<string, string>>(),
    rateLimitHeaders: jsonb("rate_limit_headers").$type<Record<string, string>>(),
    /** The request body without its input, instructions and tools. */
    params: jsonb("params").$type<Record<string, unknown>>(),
    instructionsHash: text("instructions_hash").references(() => modelBlobs.hash),
    toolsHash: text("tools_hash").references(() => modelBlobs.hash),
    responseText: text("response_text"),
    reasoningSummary: text("reasoning_summary"),
    /** The response as it came, only when it could not be rebuilt (cut short or unreadable). */
    rawResponse: text("raw_response"),
    requestBytes: bigint("request_bytes", { mode: "number" }).notNull().default(0),
    responseBytes: bigint("response_bytes", { mode: "number" }).notNull().default(0),
    parseWarnings: jsonb("parse_warnings").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [
    index("model_requests_turn_idx").on(table.codexThreadId, table.codexTurnId),
    index("model_requests_started_idx").on(table.startedAt),
    index("model_requests_teammate_idx").on(table.teammateId, table.startedAt),
    check("model_requests_source_check", oneOf(table.source, MODEL_REQUEST_SOURCES)),
    check("model_requests_route_check", oneOf(table.route, MODEL_ROUTES)),
    check("model_requests_transport_check", oneOf(table.transport, MODEL_TRANSPORTS)),
  ],
);

/** The items of a request, in order, on each side: what was sent, and what came back. */
export const modelRequestItems = pgTable(
  "model_request_items",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => modelRequests.id, { onDelete: "cascade" }),
    side: text("side").$type<ModelItemSide>().notNull(),
    position: integer("position").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => modelBlobs.hash),
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.side, table.position] }),
    // Finding blobs nothing uses any more.
    index("model_request_items_blob_idx").on(table.blobHash),
    check("model_request_items_side_check", oneOf(table.side, MODEL_ITEM_SIDES)),
  ],
);

/** Requests the writer could not save: when, how many, and why. */
export const modelLogGaps = pgTable("model_log_gaps", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** When the first and the last lost request started. */
  firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
  requests: integer("requests").notNull(),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});
