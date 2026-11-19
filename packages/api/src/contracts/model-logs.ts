import { z } from "zod";
import { base, ok, id } from "../base";
import {
  codexEventSummarySchema,
  keysetCursorSchema,
  modelLogFilterOptionsSchema,
  modelLogRetentionInputSchema,
  modelLogRetentionViewSchema,
  modelLogRunFiltersSchema,
  modelLogRunsSchema,
  modelLogToolsInputSchema,
  modelLogUsageInputSchema,
  modelLogUsageSchema,
  modelRequestBodiesSchema,
  runModelLogsSchema,
  toolFailuresInputSchema,
  toolFailuresSchema,
  toolStatSchema,
} from "../model-logs";

/** How many runs a page of the list holds. */
export const MODEL_LOG_RUNS_PAGE = 50;
/** How many tool failures a page holds. */
export const TOOL_FAILURES_PAGE = 20;

/** How many of a run's requests the inspector lists, the first ones; its totals count them all. */
export const MODEL_LOG_RUN_REQUESTS = 500;

/**
 * Where a page of runs starts: the creation time, to the microsecond, and the id of the run before
 * it, as `nextBefore` gave them. Opaque to clients; one that isn't a real time is refused. The
 * tool failures page the same way.
 */
export const runsCursorSchema = keysetCursorSchema;

export const modelLogsContract = {
  /** Runs that have model logs, newest first, filtered and searched, a page at a time. */
  runs: base
    .input(modelLogRunFiltersSchema.extend({ before: runsCursorSchema.optional() }))
    .output(modelLogRunsSchema),
  /** The teammates, chats and models the runs list can be filtered by. */
  filters: base.output(modelLogFilterOptionsSchema),
  /** One run's turns, model requests and tool calls, without request bodies. */
  run: base.input(z.object({ runId: id })).output(runModelLogsSchema),
  /** One request's input, instructions, tools and response. */
  request: base.input(z.object({ requestId: id })).output(modelRequestBodiesSchema),
  /** A run's Codex messages, in order, without their payloads. */
  events: base.input(z.object({ runId: id })).output(z.array(codexEventSummarySchema)),
  /** One Codex message's payload, as JSON text. */
  event: base.input(z.object({ eventId: id })).output(z.object({ payload: z.string() })),
  /** Each tool's calls, failures and duration across teammates over a range. */
  tools: base.input(modelLogToolsInputSchema).output(z.array(toolStatSchema)),
  /** Every failed tool call over a range, newest first, with its input and output. */
  toolFailures: base.input(toolFailuresInputSchema).output(toolFailuresSchema),
  /** Tokens, cost, errors and plan windows over a range, and this month's API key spend. */
  usage: base.input(modelLogUsageInputSchema).output(modelLogUsageSchema),
  /** How long bodies are kept. */
  retention: base.output(modelLogRetentionViewSchema),
  /** Keep bodies this many days, or forever (null). The worker saves it and sweeps. */
  setRetention: base.input(modelLogRetentionInputSchema).output(ok),
};
