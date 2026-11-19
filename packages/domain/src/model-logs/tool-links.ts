// Which tool call made each app-server item. A direct call names its item exactly: Codex gives
// the item the call's `call_id`. In code mode the model's one call is an `exec` cell whose
// JavaScript calls the tools, and Codex gives each nested call a fresh id (`exec-<uuid>` in
// Codex 0.162.1's `core/src/tools/code_mode/delegate.rs`) that no model request and no app-server
// message ties back to the cell. Nested items are linked to the cells that could have been
// running when they started, and never claimed as exact.

/** One tool call in a response's output, as `toolCallsOf` reads it. */
export interface LinkCall {
  callId: string | null;
  type: string;
  name: string;
  arguments: string | null;
}

/** A tool's result sent back to the model in a request's input. */
export interface ToolOutput {
  callId: string;
  /** The output's text, or its first text part. */
  text: string;
}

/** One model request of a thread, with the calls it answered with and the outputs it sent. */
export interface LinkRequest {
  id: string;
  startedAt: Date;
  firstByteAt: Date | null;
  calls: readonly LinkCall[];
  /** Tool outputs in the request's input (every request repeats the ones before it). */
  outputs: readonly ToolOutput[];
}

/** An app-server item of the same thread, at its first message (`item/started`, else its end). */
export interface LinkItem {
  itemId: string;
  type: string;
  at: Date;
}

/** A code-mode cell, as far as the model requests show it. */
export interface CodeModeCell {
  /** The `exec` call that started it. */
  callId: string;
  requestId: string;
  /** Its runtime id, known once it yielded (`Script running with cell ID ...`). */
  cellId: string | null;
  /**
   * When its response started streaming. Codex starts a cell as soon as the call's output item
   * is done, before the response ends, so this is the earliest it can have started.
   */
  from: Date;
  /**
   * When the first request that carried its final result started (its `exec` output, or a
   * `wait` on it, saying it completed, failed or was terminated), plus `TRANSIT_SLACK_MS`.
   * Null while nothing says it ended: it may still be running across later requests.
   */
  until: Date | null;
}

/**
 * How an item was linked to the call that made it:
 * - `exact`: a direct call, whose `call_id` is the item's id;
 * - `only_candidate`: inferred, one code-mode cell could have been running when the item
 *   started, so it is most likely that cell's, but nothing in the logs says so;
 * - `ambiguous`: several cells could have been running, all listed;
 * - `none`: no call in the logs explains it.
 */
export type ToolItemMatch = "exact" | "only_candidate" | "ambiguous" | "none";

export interface ToolItemLink {
  itemId: string;
  type: string;
  match: ToolItemMatch;
  /** The call it is exactly, or the `exec` calls whose cells could have made it. */
  callIds: string[];
}

/** App-server items that a tool call produces. */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "collabAgentToolCall",
  "functionCallOutput",
]);

/**
 * How late an item's message may reach the worker after a request it preceded. The item comes
 * over the app-server connection and the request over the model proxy, so they can arrive out of
 * order; a cell is kept a candidate this long after it is known to have ended.
 */
export const TRANSIT_SLACK_MS = 2_000;

/** Code mode's tool names (`PUBLIC_TOOL_NAME` and `WAIT_TOOL_NAME` in `codex-code-mode`). */
const EXEC_TOOL = "exec";
const WAIT_TOOL = "wait";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of a tool output: a string, or the first text part of a content list. */
function outputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return null;
  for (const part of output) if (isRecord(part) && typeof part.text === "string") return part.text;
  return null;
}

/** The tool outputs among a request's input items. */
export function toolOutputsOf(input: readonly unknown[]): ToolOutput[] {
  const outputs: ToolOutput[] = [];
  for (const item of input) {
    if (!isRecord(item) || typeof item.call_id !== "string") continue;
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") continue;
    outputs.push({ callId: item.call_id, text: outputText(item.output) ?? "" });
  }
  return outputs;
}

/**
 * What a code-mode result's status line says (`format_script_status` in Codex 0.162.1's
 * `core/src/tools/code_mode/mod.rs`): still running, with the cell's id; ended (`Script
 * completed`, `Script failed` or `Script terminated`); or nothing, for any other output. An
 * error with no status line (a `wait` whose arguments didn't parse, or a failure after the cell
 * started) says nothing about the cell, which may still be running, so it leaves it open.
 */
function scriptStatus(text: string): { running: string } | "ended" | "unknown" {
  const line = text.split("\n", 1)[0]!.trimEnd();
  const running = /^Script running with cell ID (\S+)$/.exec(line);
  if (running) return { running: running[1]! };
  return /^Script (?:completed|failed|terminated)$/.test(line) ? "ended" : "unknown";
}

function waitCellId(call: LinkCall): string | null {
  if (call.name !== WAIT_TOOL || call.type !== "function_call" || !call.arguments) return null;
  try {
    const args: unknown = JSON.parse(call.arguments);
    return isRecord(args) && typeof args.cell_id === "string" ? args.cell_id : null;
  } catch {
    return null;
  }
}

/** The code-mode cells of a thread's requests, with the window each could have run in. */
export function codeModeCells(requests: readonly LinkRequest[]): CodeModeCell[] {
  const ordered = [...requests].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const cells = new Map<string, CodeModeCell>();
  // `wait` calls, by call id, to the cell they waited on.
  const waits = new Map<string, string>();
  for (const request of ordered)
    for (const call of request.calls) {
      if (!call.callId) continue;
      if (call.name === EXEC_TOOL && call.type === "custom_tool_call")
        cells.set(call.callId, {
          callId: call.callId,
          requestId: request.id,
          cellId: null,
          from: request.firstByteAt ?? request.startedAt,
          until: null,
        });
      const waited = waitCellId(call);
      if (waited) waits.set(call.callId, waited);
    }
  const byCellId = new Map<string, CodeModeCell>();
  for (const request of ordered)
    for (const output of request.outputs) {
      const cell =
        cells.get(output.callId) ?? byCellId.get(waits.get(output.callId) ?? "\u0000") ?? null;
      if (!cell || cell.until) continue;
      const status = scriptStatus(output.text);
      if (status === "unknown") continue;
      if (status === "ended") cell.until = new Date(request.startedAt.getTime() + TRANSIT_SLACK_MS);
      else {
        cell.cellId = status.running;
        byCellId.set(status.running, cell);
      }
    }
  return [...cells.values()];
}

/**
 * Each tool item of a thread linked to the call that made it: exactly by id for a direct call,
 * else to the code-mode cells that could have been running when it started.
 */
export function linkToolItems(
  requests: readonly LinkRequest[],
  items: readonly LinkItem[],
): ToolItemLink[] {
  const direct = new Set<string>();
  for (const request of requests)
    for (const call of request.calls) if (call.callId) direct.add(call.callId);
  const cells = codeModeCells(requests);
  const links: ToolItemLink[] = [];
  for (const item of items) {
    if (!TOOL_ITEM_TYPES.has(item.type)) continue;
    if (direct.has(item.itemId)) {
      links.push({ itemId: item.itemId, type: item.type, match: "exact", callIds: [item.itemId] });
      continue;
    }
    const at = item.at.getTime();
    const callIds = cells
      .filter((cell) => cell.from.getTime() <= at && (!cell.until || at <= cell.until.getTime()))
      .map((cell) => cell.callId);
    const match: ToolItemMatch =
      callIds.length === 0 ? "none" : callIds.length === 1 ? "only_candidate" : "ambiguous";
    links.push({ itemId: item.itemId, type: item.type, match, callIds });
  }
  return links;
}
