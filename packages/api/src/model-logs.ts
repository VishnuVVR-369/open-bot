import {
  authModeSchema,
  codexEventDirectionSchema,
  codexEventKindSchema,
  isKeysetCursor,
  KEYSET_CURSOR,
  modelItemKindSchema,
  modelLogRetentionSchema,
  nestedMatchSchema,
  planWindowStepSchema,
  runLogStatusSchema,
  usageBucketSchema,
  USAGE_MAX_DAYS,
  outcomeToneSchema,
  runStatusSchema,
  runTriggerSchema,
  turnMatchSchema,
} from "@open-bot/domain";
import { z } from "zod";

/** Model logs: every model request a run made, and what Codex did around them. Owner only. */

/** Text cut to fit, with how long it was in full. */
const clippedSchema = z.object({ text: z.string(), chars: z.number() });
export type Clipped = z.infer<typeof clippedSchema>;
const clippedSchemaRef = () => clippedSchema.nullable();

/** The tokens, cost and errors of some model requests. */
const usageTotalsSchema = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  costMicros: z.number(),
  errors: z.number(),
});

/** One run that has model logs, in the list. */
export const modelLogRunSchema = usageTotalsSchema.extend({
  runId: z.string(),
  teammateId: z.string().nullable(),
  teammateName: z.string().nullable(),
  chatId: z.string(),
  chatTitle: z.string(),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  createdAt: z.string(),
  /** The access modes its turns used: the plan, the API key, or both after a fallback. */
  accessModes: z.array(authModeSchema),
  /**
   * When searching, where the run matched: a short part of the text with each hit between
   * `HIT_START` and `HIT_END` (`snippetParts` in `@open-bot/domain` splits it). Null otherwise.
   */
  match: z.string().nullable(),
  /** When its request bodies expired; null while they are kept. */
  bodiesExpiredAt: z.string().nullable(),
});
export type ModelLogRun = z.infer<typeof modelLogRunSchema>;

export const modelLogRunsSchema = z.object({
  runs: z.array(modelLogRunSchema),
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: z.string().nullable(),
});

/**
 * Where a newest-first page starts: the time of the row before it, to the microsecond, in UTC,
 * and its id (`keysetCursor` in `@open-bot/domain`). Opaque to clients.
 */
export const keysetCursorSchema = z
  .string()
  .regex(KEYSET_CURSOR, "Not a page of results")
  .refine(isKeysetCursor, "Not a page of results");

/** A date range, either end open. */
const rangeSchema = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};

/** What the runs list can be narrowed by. Every filter is optional; together they all apply. */
export const modelLogRunFiltersSchema = z.object({
  teammateId: z.uuid().optional(),
  chatId: z.uuid().optional(),
  model: z.string().max(200).optional(),
  status: runLogStatusSchema.optional(),
  access: authModeSchema.optional(),
  ...rangeSchema,
  /** Words to find in what was sent or what came back (Postgres full-text search). */
  q: z.string().max(1000).optional(),
});
export type ModelLogRunFilters = z.infer<typeof modelLogRunFiltersSchema>;

/** The choices the runs list's filters offer. */
export const modelLogFilterOptionsSchema = z.object({
  teammates: z.array(z.object({ id: z.string(), name: z.string() })),
  chats: z.array(z.object({ id: z.string(), title: z.string() })),
  models: z.array(z.string()),
});
export type ModelLogFilterOptions = z.infer<typeof modelLogFilterOptionsSchema>;

/** The Tools tab's range, and optionally one teammate. */
export const modelLogToolsInputSchema = z.object({
  teammateId: z.uuid().optional(),
  ...rangeSchema,
});

/** One tool across runs: how often it ran, how often it failed, and how long it took. */
export const toolStatSchema = z.object({
  name: z.string(),
  /** The Codex item type (`commandExecution`, `dynamicToolCall`, ...). */
  type: z.string(),
  calls: z.number(),
  failed: z.number(),
  /** Calls whose outcome wasn't stored (too large to keep). */
  unknown: z.number(),
  medianMs: z.number().nullable(),
  p95Ms: z.number().nullable(),
  teammates: z.number(),
});
export type ToolStat = z.infer<typeof toolStatSchema>;

/** How a failed tool item is tied to the model's call: exactly, by time, or not at all. */
export const failureLinkSchema = z.enum(["exact", "only_candidate", "ambiguous", "none"]);

/** One failed tool item, with what it was given and gave back. */
export const toolFailureSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  itemId: z.string(),
  at: z.string(),
  name: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  teammateId: z.string().nullable(),
  teammateName: z.string().nullable(),
  chatTitle: z.string(),
  input: clippedSchemaRef(),
  output: clippedSchemaRef(),
  error: z.string().nullable(),
  /** How the item is tied to a call, and to which: the call's tool name and arguments. */
  link: failureLinkSchema,
  /** For `ambiguous`, how many code cells could have made it. */
  candidates: z.number(),
  callName: z.string().nullable(),
  callArguments: clippedSchemaRef(),
  /** When the bodies of the run's messages expired; input and output are gone then. */
  bodiesExpiredAt: z.string().nullable(),
});
export type ToolFailure = z.infer<typeof toolFailureSchema>;

export const toolFailuresInputSchema = modelLogToolsInputSchema.extend({
  /** Only this tool, by its name in the Tools tab. */
  tool: z.string().max(300).optional(),
  before: keysetCursorSchema.optional(),
});

export const toolFailuresSchema = z.object({
  failures: z.array(toolFailureSchema),
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: z.string().nullable(),
});
export type ToolFailures = z.infer<typeof toolFailuresSchema>;

/** The Usage tab's range: both ends, in order, at most `USAGE_MAX_DAYS` apart. */
export const modelLogUsageInputSchema = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((range) => Date.parse(range.from) < Date.parse(range.to), {
    message: "The range must start before it ends.",
  })
  .refine((range) => Date.parse(range.to) - Date.parse(range.from) <= USAGE_MAX_DAYS * 86_400_000, {
    message: `The range can span at most ${USAGE_MAX_DAYS} days.`,
  });

const usageNumbersSchema = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  costMicros: z.number(),
  errors: z.number(),
});

/** Usage from model logs over a range: over time, per teammate, per model, and plan windows. */
export const modelLogUsageSchema = z.object({
  /** The owner's time zone, which days are counted in. */
  timeZone: z.string(),
  bucket: usageBucketSchema,
  /** Each day or week of the range, in order, quiet ones as zeros; `bucket` is its first day. */
  series: z.array(usageNumbersSchema.extend({ bucket: z.string() })),
  totals: usageNumbersSchema,
  teammates: z.array(
    usageNumbersSchema.extend({ teammateId: z.string().nullable(), name: z.string().nullable() }),
  ),
  models: z.array(usageNumbersSchema.extend({ model: z.string().nullable() })),
  /** The plan's usage windows: each hour's highest reading, from the responses' headers. */
  planWindows: z.object({
    /** Each point is the highest reading in its hour, or in its day in the owner's zone. */
    step: planWindowStepSchema,
    primaryMinutes: z.number().nullable(),
    secondaryMinutes: z.number().nullable(),
    points: z.array(
      z.object({
        at: z.string(),
        primary: z.number().nullable(),
        secondary: z.number().nullable(),
      }),
    ),
  }),
  /** This calendar month's API key spend, from model logs, against the monthly cap. */
  apiKey: z.object({ monthStart: z.string(), spendMicros: z.number(), capMicros: z.number() }),
});
export type ModelLogUsage = z.infer<typeof modelLogUsageSchema>;

/** How long model logs keep their bodies. */
export const modelLogRetentionViewSchema = z.object({
  days: modelLogRetentionSchema,
  /** The oldest request whose bodies are still kept, and when the last sweep expired any. */
  oldestKept: z.string().nullable(),
  lastExpiredAt: z.string().nullable(),
});
export type ModelLogRetentionView = z.infer<typeof modelLogRetentionViewSchema>;
export const modelLogRetentionInputSchema = z.object({ days: modelLogRetentionSchema });
export type ModelLogRuns = z.infer<typeof modelLogRunsSchema>;

export const toolOutcomeSchema = z.object({
  itemId: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  tone: outcomeToneSchema,
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  output: z.string().nullable(),
  outputChars: z.number(),
  /** Why its result wasn't stored, when it was too large or unreadable. */
  omitted: z.string().nullable(),
});
export type ToolOutcomeView = z.infer<typeof toolOutcomeSchema>;

export const nestedOutcomeSchema = toolOutcomeSchema.extend({
  match: nestedMatchSchema,
  candidates: z.number(),
});
export type NestedOutcomeView = z.infer<typeof nestedOutcomeSchema>;

export const toolCallViewSchema = z.object({
  position: z.number(),
  callId: z.string().nullable(),
  type: z.string(),
  name: z.string(),
  namespace: z.string().nullable(),
  arguments: clippedSchema.nullable(),
  /** The item the call made, joined by its id. */
  outcome: toolOutcomeSchema.nullable(),
  /** What the model was sent back for it. */
  returned: clippedSchema.nullable(),
  /** A code-mode `exec` call's nested items, linked by time, never exactly. */
  nested: z.array(nestedOutcomeSchema),
});
export type ToolCallView = z.infer<typeof toolCallViewSchema>;

/** One model request, without its bodies. */
export const modelRequestSummarySchema = z.object({
  id: z.string(),
  /** Codex's `request_kind` (`turn`, `prewarm`, `compaction`, `memory`), when it named one. */
  kind: z.string().nullable(),
  model: z.string().nullable(),
  route: z.string().nullable(),
  transport: z.string(),
  method: z.string(),
  endpoint: z.string(),
  status: z.number().nullable(),
  failed: z.boolean(),
  startedAt: z.string(),
  firstByteAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  costMicros: z.number(),
  stopReason: z.string().nullable(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  rateLimits: z.record(z.string(), z.string()).nullable(),
  parseWarnings: z.array(z.string()),
  inputItems: z.number(),
  outputItems: z.number(),
  /** Over a WebSocket, where the items the message itself sent begin. */
  sentInputFrom: z.number().nullable(),
  /** `time` when the request named no turn and was placed by when it started. */
  turnMatch: turnMatchSchema,
  /** When its bodies expired (`settings.model_log_retention_days`); null while kept. */
  bodiesExpiredAt: z.string().nullable(),
  /** The failed request this one sent again. */
  retryOf: z.string().nullable(),
  toolCalls: z.array(toolCallViewSchema),
});
export type ModelRequestSummary = z.infer<typeof modelRequestSummarySchema>;

export const modelLogTurnSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  accessMode: authModeSchema,
  startedAt: z.string(),
  requests: z.array(modelRequestSummarySchema),
});
export type ModelLogTurn = z.infer<typeof modelLogTurnSchema>;

/** A run's model logs, without request bodies. */
export const runModelLogsSchema = z.object({
  run: z.object({
    id: z.string(),
    teammateId: z.string().nullable(),
    teammateName: z.string().nullable(),
    chatId: z.string(),
    chatTitle: z.string(),
    prompt: z.string(),
    trigger: runTriggerSchema,
    status: runStatusSchema,
    error: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
  /** Every request of the run, whether listed or not. */
  totals: usageTotalsSchema,
  /** How many requests `turns` lists: all of them, or the first `MODEL_LOG_RUN_REQUESTS`. */
  shownRequests: z.number(),
  turns: z.array(modelLogTurnSchema),
  /** Tool items no call in the logs explains. */
  unlinkedTools: z.array(toolOutcomeSchema),
  /** How many Codex messages were logged for the run. */
  events: z.number(),
  /** When the first of its bodies expired; null while all are kept. */
  bodiesExpiredAt: z.string().nullable(),
});
export type RunModelLogs = z.infer<typeof runModelLogsSchema>;

const describedItemSchema = z.object({
  position: z.number(),
  kind: modelItemKindSchema,
  label: z.string(),
  text: z.string(),
  callId: z.string().nullable(),
  type: z.string().nullable(),
  /** The item as stored, as JSON text. */
  json: z.string().nullable(),
});

/** A request's bodies, loaded when it is opened. */
export const modelRequestBodiesSchema = z.object({
  id: z.string(),
  input: z.array(describedItemSchema.extend({ sent: z.boolean() })),
  /** Input positions with nothing stored. */
  missingInput: z.array(z.number()),
  instructions: z.string().nullable(),
  tools: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().nullable(),
      json: z.string(),
    }),
  ),
  output: z.array(describedItemSchema),
  responseText: z.string().nullable(),
  reasoningSummary: z.string().nullable(),
  /** The response as it came, only when it could not be rebuilt. */
  rawResponse: z.string().nullable(),
  /** The request body without its input, instructions and tools, as JSON text. */
  params: z.string().nullable(),
  /** The whole body rebuilt in the shape it was sent, as JSON text; null once it expired. */
  body: z.string().nullable(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()).nullable(),
});
export type ModelRequestBodies = z.infer<typeof modelRequestBodiesSchema>;

/** One Codex app-server message of a run, without its payload. */
export const codexEventSummarySchema = z.object({
  id: z.string(),
  at: z.string(),
  direction: codexEventDirectionSchema,
  kind: codexEventKindSchema,
  method: z.string(),
  itemId: z.string().nullable(),
  turnId: z.string().nullable(),
  /** The payload's size as JSON text. */
  size: z.number(),
  /** Why the payload wasn't stored, for a message too large or unreadable. */
  omitted: z.string().nullable(),
  /** When the payload was cut down to its numbers and statuses by the retention sweep. */
  bodiesExpiredAt: z.string().nullable(),
  deltaCounts: z.record(z.string(), z.record(z.string(), z.number())).nullable(),
});
export type CodexEventSummary = z.infer<typeof codexEventSummarySchema>;
