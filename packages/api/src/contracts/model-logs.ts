import { z } from "zod";
import { base, id } from "../base";
import {
  codexEventSummarySchema,
  modelLogRunsSchema,
  modelRequestBodiesSchema,
  runModelLogsSchema,
} from "../model-logs";

/** How many runs a page of the list holds. */
export const MODEL_LOG_RUNS_PAGE = 50;

/** How many of a run's requests the inspector lists, the first ones; its totals count them all. */
export const MODEL_LOG_RUN_REQUESTS = 500;

const CURSOR =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Whether the cursor's time is a real one: a month that exists, a day it has, a time of day. */
function realInstant(cursor: string): boolean {
  const match = CURSOR.exec(cursor);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    year >= 1 &&
    days !== undefined &&
    day >= 1 &&
    day <= days &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

/**
 * Where a page of runs starts: the creation time, to the microsecond, and the id of the run before
 * it, as `nextBefore` gave them. Opaque to clients; one that isn't a real time is refused.
 */
export const runsCursorSchema = z
  .string()
  .regex(CURSOR, "Not a page of runs")
  .refine(realInstant, "Not a page of runs");

export const modelLogsContract = {
  /** Runs that have model logs, newest first. */
  runs: base.input(z.object({ before: runsCursorSchema.optional() })).output(modelLogRunsSchema),
  /** One run's turns, model requests and tool calls, without request bodies. */
  run: base.input(z.object({ runId: id })).output(runModelLogsSchema),
  /** One request's input, instructions, tools and response. */
  request: base.input(z.object({ requestId: id })).output(modelRequestBodiesSchema),
  /** A run's Codex messages, in order, without their payloads. */
  events: base.input(z.object({ runId: id })).output(z.array(codexEventSummarySchema)),
  /** One Codex message's payload, as JSON text. */
  event: base.input(z.object({ eventId: id })).output(z.object({ payload: z.string() })),
};
