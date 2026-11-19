// A run's model logs put together for the inspector: its requests under the turns they belong
// to, which ones retried a failed one, and every tool call with its outcome from the app-server
// stream. Exact where the logs say so, and marked as inferred where they don't.
import { z } from "zod";
import {
  type LinkCall,
  type LinkItem,
  type LinkRequest,
  linkToolItems,
  type ToolItemMatch,
  type ToolOutput,
} from "./tool-links";

/**
 * How long before a turn's `turn/start` returned a request without a turn id may have started and
 * still count as that turn's. Codex names no turn on a prewarm, which it sends as the turn starts,
 * sometimes before `turn/start` has returned and the turn was saved.
 */
export const UNTURNED_SLACK_MS = 10_000;

/** A turn of the run (`run_turns`). */
export interface TurnRow {
  threadId: string;
  turnId: string;
  startedAt: Date;
}

/** The part of a model request that places it: its thread, turn, kind, time and outcome. */
export interface PlacedRequestRow {
  id: string;
  threadId: string | null;
  /** The turn the request named; null for a prewarm. */
  turnId: string | null;
  /**
   * The turn it belongs to: the one it named, or for a request that named none, the one its
   * thread's turns place it in by time (`unturnedTurnSql` in the web app's model logs).
   */
  placedTurnId: string | null;
  requestKind: string | null;
  startedAt: Date;
  status: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

/** How a request was tied to its turn. */
export const TURN_MATCHES = ["turn", "time"] as const;
export const turnMatchSchema = z.enum(TURN_MATCHES);
export type TurnMatch = (typeof TURN_MATCHES)[number];

export interface PlacedRequest<R extends PlacedRequestRow> {
  request: R;
  /** Index into the turns. */
  turn: number;
  /** `turn` when the request named the turn, `time` when it named none and fell inside it. */
  match: TurnMatch;
}

/** Whether a request failed: no answer, an error status, or an error the response reported. */
export function requestFailed(request: {
  status: number | null;
  errorType: string | null;
  errorMessage: string | null;
}): boolean {
  return (
    request.status === null ||
    request.status >= 400 ||
    request.errorType !== null ||
    request.errorMessage !== null
  );
}

/**
 * Puts each request under its turn of the run, by thread and `placedTurnId`; a request that named
 * no turn is marked as placed by time. Requests of no turn of the run are left out. Each turn's
 * requests are in the order they started.
 */
export function placeRequests<R extends PlacedRequestRow>(
  turns: readonly TurnRow[],
  requests: readonly R[],
): PlacedRequest<R>[] {
  const placed: PlacedRequest<R>[] = [];
  for (const request of requests) {
    if (!request.threadId || !request.placedTurnId) continue;
    const turn = turns.findIndex(
      (t) => t.threadId === request.threadId && t.turnId === request.placedTurnId,
    );
    if (turn >= 0) placed.push({ request, turn, match: request.turnId ? "turn" : "time" });
  }
  return placed.sort(
    (a, b) => a.turn - b.turn || a.request.startedAt.getTime() - b.request.startedAt.getTime(),
  );
}

/**
 * The request each one retried: the one just before it in the same turn, of the same kind, when
 * that one failed. Codex sends a request again after a stream error or a refused upgrade.
 */
export function retriesOf<R extends PlacedRequestRow>(
  placed: readonly PlacedRequest<R>[],
): Map<string, string> {
  const retries = new Map<string, string>();
  for (let i = 1; i < placed.length; i++) {
    const before = placed[i - 1]!;
    const current = placed[i]!;
    if (before.turn !== current.turn) continue;
    if (before.request.requestKind !== current.request.requestKind) continue;
    if (requestFailed(before.request)) retries.set(current.request.id, before.request.id);
  }
  return retries;
}

/* ------------------------------------------------------------------ Tool outcomes */

/** A tool call the model made (`model_tool_calls`), with the request that made it. */
export interface ToolCallRow extends LinkCall {
  requestId: string;
  position: number;
  namespace: string | null;
}

/**
 * An app-server item of the run, from its `item/started` and `item/completed` rows. `item` is the
 * completed item (else the started one) without its large fields; `output` is the start of its
 * output, `outputChars` its whole length.
 */
export interface ToolItemRow {
  itemId: string;
  threadId: string;
  type: string;
  /** When it started (`item/started`), else when it completed. */
  at: Date;
  completed: boolean;
  item: Record<string, unknown> | null;
  output: string | null;
  outputChars: number;
  /** Why its completed message was not stored, when it was too large or unreadable. */
  omitted: string | null;
}

/** How an outcome reads: done, failed, still going, or not known. */
export const OUTCOME_TONES = ["ok", "error", "working", "unknown"] as const;
export const outcomeToneSchema = z.enum(OUTCOME_TONES);
export type OutcomeTone = (typeof OUTCOME_TONES)[number];

/** The inferred matches of a nested item to a code-mode cell (`ToolItemMatch`). */
export const NESTED_MATCHES = [
  "only_candidate",
  "ambiguous",
] as const satisfies readonly ToolItemMatch[];
export const nestedMatchSchema = z.enum(NESTED_MATCHES);

/** What a tool item did, read from its completed app-server item. */
export interface ToolOutcome {
  itemId: string;
  type: string;
  /** What it ran or touched: the command, the files, the tool's name, the query. */
  title: string;
  status: string | null;
  tone: OutcomeTone;
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
  output: string | null;
  outputChars: number;
  omitted: string | null;
}

/** A nested item of a code-mode `exec` call, linked by time, never by id. */
export interface NestedOutcome extends ToolOutcome {
  match: (typeof NESTED_MATCHES)[number];
  /** How many `exec` calls could have made it. */
  candidates: number;
}

export interface ToolCallView {
  requestId: string;
  position: number;
  callId: string | null;
  type: string;
  name: string;
  namespace: string | null;
  arguments: string | null;
  /** The item the call made, by its id. */
  outcome: ToolOutcome | null;
  /** What the model was sent back for it, from a later request's input. */
  returned: ToolOutput | null;
  /** For a code-mode `exec` call: the items it most likely made, by time. */
  nested: NestedOutcome[];
}

export interface RunToolsView {
  /** By request id, in the order the model made them. */
  calls: Map<string, ToolCallView[]>;
  /** Tool items no call in the logs explains. */
  unlinked: ToolOutcome[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const ERROR_STATUSES = new Set(["failed", "declined", "error", "rejected", "cancelled"]);
const WORKING_STATUSES = new Set(["inProgress", "in_progress", "running", "pending"]);

/** What an item ran or touched, in a few words. */
function titleOf(type: string, item: Record<string, unknown>): string {
  switch (type) {
    case "commandExecution":
      return str(item.command) ?? "Command";
    case "fileChange": {
      const paths = Array.isArray(item.paths)
        ? item.paths.filter((p) => typeof p === "string")
        : [];
      return paths.length ? paths.join(", ") : "File change";
    }
    case "mcpToolCall":
      return [str(item.server), str(item.tool)].filter(Boolean).join(".") || "MCP tool";
    case "dynamicToolCall":
      return [str(item.namespace), str(item.tool)].filter(Boolean).join(".") || "Tool";
    case "webSearch":
      return str(item.query) ?? "Web search";
    case "imageView":
      return str(item.path) ?? "Image";
    case "collabAgentToolCall":
      return str(item.tool) ?? "Teammate tool";
    case "functionCallOutput":
      return str(item.name) ?? "Tool output";
    default:
      return type;
  }
}

/** An item's outcome: its status, exit code, duration and error, and the start of its output. */
export function outcomeOf(row: ToolItemRow): ToolOutcome {
  const item = row.item ?? {};
  const status = str(item.status);
  const exitCode = num(item.exitCode);
  const error = isRecord(item.error)
    ? (str(item.error.message) ?? JSON.stringify(item.error))
    : str(item.error);
  const success = typeof item.success === "boolean" ? item.success : null;
  let tone: OutcomeTone;
  if (row.omitted && !row.completed) tone = "unknown";
  else if (error || success === false || (exitCode !== null && exitCode !== 0)) tone = "error";
  else if (status && ERROR_STATUSES.has(status)) tone = "error";
  else if (!row.completed || (status && WORKING_STATUSES.has(status))) tone = "working";
  else tone = "ok";
  return {
    itemId: row.itemId,
    type: row.type,
    title: titleOf(row.type, item),
    status: row.omitted ? null : row.completed ? status : (status ?? "started"),
    tone,
    exitCode,
    durationMs: num(item.durationMs),
    error,
    output: row.output,
    outputChars: row.outputChars,
    omitted: row.omitted,
  };
}

/** Code mode's cell tool, whose nested calls are linked by time. */
const EXEC_TOOL = "exec";

/**
 * Every tool call of a run with its outcome. Requests and items are grouped by thread, since ids
 * and code-mode cells only mean something within one; `requests` are the run's requests with the
 * tool outputs their input carried, `calls` the calls they made, and `items` the run's tool items.
 */
export function runTools(
  requests: readonly (Omit<LinkRequest, "calls"> & { threadId: string | null })[],
  calls: readonly ToolCallRow[],
  items: readonly ToolItemRow[],
): RunToolsView {
  const callsByRequest = new Map<string, ToolCallRow[]>();
  for (const call of [...calls].sort((a, b) => a.position - b.position)) {
    const list = callsByRequest.get(call.requestId) ?? [];
    list.push(call);
    callsByRequest.set(call.requestId, list);
  }
  const outcomes = new Map(
    items.map((row) => [`${row.threadId}\u0000${row.itemId}`, outcomeOf(row)]),
  );
  // The first output each call got back, in request order. Call ids only mean something within
  // one thread, like item ids.
  const returned = new Map<string, ToolOutput>();
  for (const request of [...requests].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()))
    for (const output of request.outputs) {
      const key = `${request.threadId}\u0000${output.callId}`;
      if (!returned.has(key)) returned.set(key, output);
    }

  const view: RunToolsView = { calls: new Map(), unlinked: [] };
  const threads = new Set([...requests.map((r) => r.threadId), ...items.map((i) => i.threadId)]);
  for (const thread of threads) {
    if (thread === null) continue;
    const threadRequests: LinkRequest[] = requests
      .filter((r) => r.threadId === thread)
      .map((r) => ({ ...r, calls: callsByRequest.get(r.id) ?? [] }));
    const threadItems: LinkItem[] = items
      .filter((i) => i.threadId === thread)
      .map((i) => ({ itemId: i.itemId, type: i.type, at: i.at }));
    const links = linkToolItems(threadRequests, threadItems);
    const nestedByCall = new Map<string, NestedOutcome[]>();
    for (const link of links) {
      const outcome = outcomes.get(`${thread}\u0000${link.itemId}`);
      if (!outcome) continue;
      if (link.match === "none") view.unlinked.push(outcome);
      if (link.match !== "only_candidate" && link.match !== "ambiguous") continue;
      for (const callId of link.callIds) {
        const list = nestedByCall.get(callId) ?? [];
        list.push({ ...outcome, match: link.match, candidates: link.callIds.length });
        nestedByCall.set(callId, list);
      }
    }
    for (const request of threadRequests) {
      const list: ToolCallView[] = (request.calls as ToolCallRow[]).map((call) => ({
        requestId: request.id,
        position: call.position,
        callId: call.callId,
        type: call.type,
        name: call.name,
        namespace: call.namespace,
        arguments: call.arguments,
        outcome: call.callId ? (outcomes.get(`${thread}\u0000${call.callId}`) ?? null) : null,
        returned: call.callId ? (returned.get(`${thread}\u0000${call.callId}`) ?? null) : null,
        nested:
          call.name === EXEC_TOOL && call.type === "custom_tool_call" && call.callId
            ? (nestedByCall.get(call.callId) ?? [])
            : [],
      }));
      if (list.length) view.calls.set(request.id, list);
    }
  }
  return view;
}
