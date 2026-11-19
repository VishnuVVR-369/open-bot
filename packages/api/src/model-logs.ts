import {
  authModeSchema,
  codexEventDirectionSchema,
  codexEventKindSchema,
  modelItemKindSchema,
  nestedMatchSchema,
  outcomeToneSchema,
  runStatusSchema,
  runTriggerSchema,
  turnMatchSchema,
} from "@open-bot/domain";
import { z } from "zod";

/** Model logs: every model request a run made, and what Codex did around them. Owner only. */

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
});
export type ModelLogRun = z.infer<typeof modelLogRunSchema>;

export const modelLogRunsSchema = z.object({
  runs: z.array(modelLogRunSchema),
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: z.string().nullable(),
});
export type ModelLogRuns = z.infer<typeof modelLogRunsSchema>;

/** Text cut to fit, with how long it was in full. */
const clippedSchema = z.object({ text: z.string(), chars: z.number() });
export type Clipped = z.infer<typeof clippedSchema>;

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
  deltaCounts: z.record(z.string(), z.record(z.string(), z.number())).nullable(),
});
export type CodexEventSummary = z.infer<typeof codexEventSummarySchema>;
