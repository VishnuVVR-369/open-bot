// Model logs: every model request the model proxy forwards (and the worker's memory AI makes), its
// parts stored once by hash, the tool calls the model made, the Codex app-server stream, each
// run's turns, and the batches the writer had to drop. Requests link to runs through Codex's
// thread and turn ids and `run_turns`, joined when read, never resolved when written.
import {
  AUTH_MODES,
  type AuthMode,
  CODEX_EVENT_DIRECTIONS,
  CODEX_EVENT_KINDS,
  type CodexEventDirection,
  type CodexEventKind,
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
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { runs } from "./runs";
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
  (table) => [
    check("model_blobs_kind_check", oneOf(table.kind, MODEL_BLOB_KINDS)),
    // Text search over what was sent and what came back: each blob's JSON string values, decoded,
    // the first 100,000 characters of them. `model_blob_search_text` is created by migration 0039.
    index("model_blobs_search_idx").using(
      "gin",
      sql`to_tsvector('simple', model_blob_search_text(${table.content}))`,
    ),
  ],
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
    /** The HTTP method; over a WebSocket, the message type (`response.create`). */
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
    /**
     * The tokens and cost are an estimate (`estimateUsage` in @open-bot/domain): an API key request
     * that may have cost money ended without reporting its usage (cut off, cancelled, unreadable).
     */
    usageEstimated: boolean("usage_estimated").notNull().default(false),
    /**
     * Counted toward usage (the monthly cap, Settings and each reply's footer). Set on every row a
     * worker writes once it no longer writes `usage_entries`; a worker from before that leaves it
     * false, and its usage counts from `usage_entries` instead (the runs' legacy totals). So each
     * request counts through exactly one producer, whatever the clocks or the order of deploys.
     */
    countsUsage: boolean("counts_usage").notNull().default(false),
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
    /**
     * Over a WebSocket, how many items at the start of the stored input the message did not send:
     * they continue the previous response (`previous_response_id`) and were rebuilt from the
     * connection. Null when the stored input is what was sent.
     */
    sentInputFrom: integer("sent_input_from"),
    instructionsHash: text("instructions_hash").references(() => modelBlobs.hash),
    toolsHash: text("tools_hash").references(() => modelBlobs.hash),
    responseText: text("response_text"),
    reasoningSummary: text("reasoning_summary"),
    /** The response as it came, only when it could not be rebuilt (cut short or unreadable). */
    rawResponse: text("raw_response"),
    requestBytes: bigint("request_bytes", { mode: "number" }).notNull().default(0),
    responseBytes: bigint("response_bytes", { mode: "number" }).notNull().default(0),
    parseWarnings: jsonb("parse_warnings").$type<string[]>().notNull().default([]),
    /**
     * When the retention sweep removed the request's bodies: its items, instructions, tools,
     * response text, reasoning summary, raw response and tool call arguments. Null while kept.
     */
    bodiesExpiredAt: timestamp("bodies_expired_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("model_requests_turn_idx").on(table.codexThreadId, table.codexTurnId),
    index("model_requests_started_idx").on(table.startedAt),
    index("model_requests_teammate_idx").on(table.teammateId, table.startedAt),
    // This month's API key spend, for the monthly cap.
    index("model_requests_api_started_idx")
      .on(table.startedAt)
      .where(sql`${table.route} = 'api' and ${table.countsUsage}`),
    // Filtering runs and usage by model.
    index("model_requests_model_idx").on(table.model, table.startedAt),
    // Deleting a blob checks nothing still names it; without these that is a scan per blob.
    index("model_requests_instructions_idx").on(table.instructionsHash),
    index("model_requests_tools_idx").on(table.toolsHash),
    // The retention sweep's next batch: the oldest requests that still have bodies.
    index("model_requests_unexpired_idx")
      .on(table.startedAt)
      .where(sql`${table.bodiesExpiredAt} is null`),
    // Text search over responses (see `MODEL_LOG_SEARCH_CHARS` in @open-bot/domain).
    index("model_requests_response_search_idx").using(
      "gin",
      sql`to_tsvector('simple', left(coalesce(${table.responseText}, ''), 100000))`,
    ),
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

/**
 * A tool call the model made, read from a response's output items when the request was captured.
 * Its outcome is in `codex_events`: the app-server item with the same id in the same thread (see
 * the join rules in the data docs).
 */
export const modelToolCalls = pgTable(
  "model_tool_calls",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => modelRequests.id, { onDelete: "cascade" }),
    /** The call's place among the response's output items. */
    position: integer("position").notNull(),
    /** The wire `call_id`, or for a web search or image generation the output item's `id`. */
    callId: text("call_id"),
    /** The output item's type: `function_call`, `custom_tool_call`, `web_search_call`, ... */
    type: text("type").notNull(),
    name: text("name").notNull(),
    namespace: text("namespace"),
    /** What the model passed, as text: JSON arguments, a custom tool's input, or an action. */
    arguments: text("arguments"),
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.position] }),
    index("model_tool_calls_call_idx").on(table.callId),
    index("model_tool_calls_name_idx").on(table.name),
  ],
);

/**
 * One JSON-RPC message between the worker and the Codex app-server, either way, without streaming
 * deltas (counted in `delta_counts` instead) and with every credential redacted.
 */
export const codexEvents = pgTable(
  "codex_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The run the message belongs to, known when it was captured; null for one that has none. */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    codexThreadId: text("codex_thread_id"),
    codexTurnId: text("codex_turn_id"),
    /**
     * The app-server item it is about: an item's id, an approval's `itemId`, or a dynamic tool
     * call's `callId`. For tool calls this is the model's `call_id`.
     */
    itemId: text("item_id"),
    /**
     * Wire order across the worker's life: it starts at the worker's start time in microseconds
     * and counts up by one per message, so it keeps increasing across restarts.
     */
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    direction: text("direction").$type<CodexEventDirection>().notNull(),
    kind: text("kind").$type<CodexEventKind>().notNull(),
    /** The JSON-RPC method; a response has its request's. */
    method: text("method").notNull(),
    /** The JSON-RPC id, pairing a request with its response; null for a notification. */
    rpcId: text("rpc_id"),
    /** A request's or notification's params, or a response's `{ result }` or `{ error }`. */
    payload: jsonb("payload"),
    /**
     * Streaming deltas not stored, by item and method (`{ "<item>": { "item/agentMessage/delta":
     * 12 } }`): on an item's `item/completed`, its own; on `turn/completed`, those of items that
     * never completed.
     */
    deltaCounts: jsonb("delta_counts").$type<Record<string, Record<string, number>>>(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /**
     * When the retention sweep cut `payload` down to what isn't a body: an item's type, id,
     * status, exit code, duration, tool names and a short error, or a turn's id and status.
     */
    bodiesExpiredAt: timestamp("bodies_expired_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("codex_events_run_idx").on(table.runId, table.sequence),
    // The Tools tab: tool items completed in a date range.
    index("codex_events_completed_idx")
      .on(table.at)
      .where(sql`${table.method} = 'item/completed'`),
    // The retention sweep's next batch: the oldest messages that still have their payload.
    index("codex_events_unexpired_idx")
      .on(table.at)
      .where(sql`${table.bodiesExpiredAt} is null`),
    // Tool calls to their outcomes: model_tool_calls.call_id to the item in the request's thread.
    index("codex_events_item_idx").on(table.codexThreadId, table.itemId),
    index("codex_events_turn_idx").on(table.codexThreadId, table.codexTurnId),
    check("codex_events_direction_check", oneOf(table.direction, CODEX_EVENT_DIRECTIONS)),
    check("codex_events_kind_check", oneOf(table.kind, CODEX_EVENT_KINDS)),
  ],
);

/**
 * A turn of a run, saved when `turn/start` returns. A run has more than one when the plan ran out
 * and it went on with the API key in a forked thread; model requests are joined to runs through
 * this table by their thread and turn.
 */
export const runTurns = pgTable(
  "run_turns",
  {
    codexThreadId: text("codex_thread_id").notNull(),
    codexTurnId: text("codex_turn_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    accessMode: text("access_mode").$type<AuthMode>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.codexThreadId, table.codexTurnId] }),
    index("run_turns_run_idx").on(table.runId, table.startedAt),
    // A request that names no turn is placed by its thread's turns in the order they started,
    // the latest before it or the next after it (the web app's `unturnedTurnSql`).
    index("run_turns_thread_started_idx").on(
      table.codexThreadId,
      table.startedAt,
      table.codexTurnId,
    ),
    check("run_turns_access_mode_check", oneOf(table.accessMode, AUTH_MODES)),
  ],
);

/** What the writer could not save: when, how many of each, and why. */
export const modelLogGaps = pgTable("model_log_gaps", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * When the first and the last lost record was captured. A worker that writes the API key fields
   * below keeps each gap within one calendar month (UTC), so its API key spend counts in the month
   * its requests started.
   */
  firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
  /** Model requests lost. */
  requests: integer("requests").notNull(),
  /** Codex app-server messages lost. */
  codexEvents: integer("codex_events").notNull().default(0),
  /** Run turns lost. */
  runTurns: integer("run_turns").notNull().default(0),
  /**
   * Of the requests lost, those on the API key. Written only by workers that count usage from the
   * model logs (see `model_requests.counts_usage`); older ones leave these at 0.
   */
  apiRequests: integer("api_requests").notNull().default(0),
  /** What they cost, in millionths of a dollar, estimated for some; the cap counts it. */
  apiCostMicros: bigint("api_cost_micros", { mode: "number" }).notNull().default(0),
  /** Of those, the ones whose cost is an estimate (`model_requests.usage_estimated`). */
  apiRequestsEstimated: integer("api_requests_estimated").notNull().default(0),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});
