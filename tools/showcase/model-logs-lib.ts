// Typed helpers for seeding model logs: requests with their items stored by hash, the tool calls
// read from their output the way the worker's writer reads them, run turns, and Codex messages.
import { createHash, randomUUID } from "node:crypto";
import {
  codexEvents,
  modelBlobs,
  modelRequestItems,
  modelRequests,
  modelToolCalls,
  runTurns,
} from "@open-bot/db";
import {
  type AuthMode,
  type CodexEventDirection,
  type CodexEventKind,
  EXPIRED_ITEM_FIELDS,
  type ModelBlobKind,
  outputTexts,
  requestCostMicros,
  toolCallsOf,
} from "@open-bot/domain";
import { plus, type Db } from "./lib";

export const sec = (seconds: number) => Math.round(seconds * 1000);

/** A Codex message, an `input_text` part. */
export const said = (role: "user" | "developer" | "assistant", text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});

export const reasoning = (summary: string) => ({
  type: "reasoning",
  id: `rs_${randomUUID().replaceAll("-", "")}`,
  summary: [{ type: "summary_text", text: summary }],
  encrypted_content: `gAAAAA${createHash("sha256").update(summary).digest("base64")}`,
});

export const execCall = (callId: string, code: string) => ({
  type: "custom_tool_call",
  id: `ctc_${callId}`,
  call_id: callId,
  name: "exec",
  input: code,
  status: "completed",
});

export const execOutput = (callId: string, text: string) => ({
  type: "custom_tool_call_output",
  call_id: callId,
  output: [{ type: "input_text", text }],
});

export const functionCall = (callId: string, name: string, args: unknown) => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});

export const functionOutput = (callId: string, output: string) => ({
  type: "function_call_output",
  call_id: callId,
  output,
});

export interface RequestSpec {
  teammateId: string;
  threadId: string;
  turnId: string | null;
  kind: "turn" | "prewarm" | "compaction";
  route: "plan" | "api";
  startedAt: Date;
  /** Milliseconds to the first byte, and to the end; no end means it never finished. */
  firstByteMs?: number;
  endMs?: number;
  status: number | null;
  input: unknown[];
  output: unknown[];
  /** Over a WebSocket, where the items this message sent begin. */
  sentInputFrom?: number | null;
  instructions?: string | null;
  tools?: unknown[] | null;
  tokens?: { input: number; cached: number; output: number; reasoning?: number };
  error?: { type: string; message: string };
  rateLimits?: Record<string, string>;
  model?: string;
  /** Bodies removed by the retention sweep on this date: numbers kept, text gone. */
  expiredAt?: Date;
}

/** Plan usage, as the rate-limit headers on each plan response say it. */
export function planLimits(primary: number, secondary: number): Record<string, string> {
  return {
    "x-codex-primary-used-percent": String(primary),
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "9120",
    "x-codex-secondary-used-percent": String(secondary),
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-after-seconds": "312400",
  };
}

export class LogSeeder {
  private readonly blobs = new Set<string>();
  private sequence = Date.now() * 1000;

  constructor(readonly db: Db) {}

  private async blob(value: unknown, kind: ModelBlobKind): Promise<string> {
    const content = JSON.stringify(value);
    const hash = createHash("sha256").update(content).digest("hex");
    if (!this.blobs.has(hash)) {
      this.blobs.add(hash);
      await this.db.insert(modelBlobs, { hash, kind, content, bytes: Buffer.byteLength(content) });
    }
    return hash;
  }

  /** One model request, its items, and the tool calls in its output. */
  async request(
    spec: RequestSpec,
  ): Promise<{ id: string; endedAt: Date | null; firstByteAt: Date | null }> {
    const id = randomUUID();
    const websocket = spec.route === "plan";
    const firstByteAt =
      spec.firstByteMs === undefined ? null : plus(spec.startedAt, spec.firstByteMs);
    const endedAt = spec.endMs === undefined ? null : plus(spec.startedAt, spec.endMs);
    const { text, reasoningSummary } = outputTexts(spec.output);
    const tokens = spec.tokens;
    const model = spec.model ?? "gpt-5.5";
    const expired = spec.expiredAt !== undefined;
    await this.db.insert(modelRequests, {
      id,
      source: "codex",
      route: spec.route,
      transport: websocket ? "websocket" : "http",
      method: websocket ? "response.create" : "POST",
      endpoint: "/responses",
      codexThreadId: spec.threadId,
      codexTurnId: spec.turnId,
      requestKind: spec.kind,
      teammateId: spec.teammateId,
      model,
      responseId: spec.status === 200 ? `resp_${randomUUID().replaceAll("-", "")}` : null,
      status: spec.status,
      startedAt: spec.startedAt,
      firstByteAt,
      endedAt,
      inputTokens: tokens?.input ?? null,
      cachedInputTokens: tokens?.cached ?? null,
      outputTokens: tokens?.output ?? null,
      reasoningTokens: tokens?.reasoning ?? null,
      costMicros: requestCostMicros(
        spec.route,
        tokens
          ? {
              inputTokens: tokens.input,
              cachedInputTokens: tokens.cached,
              outputTokens: tokens.output,
              reasoningTokens: tokens.reasoning ?? 0,
            }
          : null,
      ),
      stopReason: spec.error ? "failed" : spec.status === 200 ? "completed" : null,
      errorType: spec.error?.type ?? null,
      errorMessage: spec.error?.message ?? null,
      requestHeaders: {
        "content-type": "application/json",
        "session-id": spec.threadId,
        ...(websocket ? {} : { "x-codex-turn-metadata": JSON.stringify({ turn_id: spec.turnId }) }),
      },
      responseHeaders: websocket ? null : { "content-type": "text/event-stream" },
      rateLimitHeaders: spec.rateLimits ?? null,
      params: {
        model,
        stream: true,
        store: false,
        parallel_tool_calls: true,
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: spec.threadId,
        ...(spec.kind === "prewarm" ? { generate: false } : {}),
      },
      sentInputFrom: websocket ? (spec.sentInputFrom ?? null) : null,
      instructionsHash:
        spec.instructions && !expired ? await this.blob(spec.instructions, "instructions") : null,
      toolsHash: spec.tools?.length && !expired ? await this.blob(spec.tools, "tools") : null,
      responseText: expired ? null : text || null,
      reasoningSummary: expired ? null : reasoningSummary || null,
      bodiesExpiredAt: spec.expiredAt ?? null,
      requestBytes: JSON.stringify(spec.input).length,
      responseBytes: JSON.stringify(spec.output).length,
    });
    for (const [side, items] of [
      ["input", expired ? [] : spec.input],
      ["output", expired ? [] : spec.output],
    ] as const)
      for (const [position, item] of items.entries())
        await this.db.insert(modelRequestItems, {
          requestId: id,
          side,
          position,
          blobHash: await this.blob(item, "item"),
        });
    for (const call of toolCallsOf(spec.output))
      await this.db.insert(modelToolCalls, {
        requestId: id,
        ...call,
        ...(expired ? { arguments: null } : {}),
      });
    return { id, endedAt, firstByteAt };
  }

  async turn(runId: string, threadId: string, turnId: string, accessMode: AuthMode, at: Date) {
    await this.db.insert(runTurns, {
      runId,
      codexThreadId: threadId,
      codexTurnId: turnId,
      accessMode,
      startedAt: at,
    });
  }

  /** One Codex message of a run. */
  async event(spec: {
    runId: string;
    threadId: string;
    turnId: string | null;
    at: Date;
    method: string;
    direction?: CodexEventDirection;
    kind?: CodexEventKind;
    itemId?: string | null;
    rpcId?: string | null;
    payload: unknown;
    deltaCounts?: Record<string, Record<string, number>>;
    expiredAt?: Date;
  }) {
    this.sequence += 1;
    await this.db.insert(codexEvents, {
      runId: spec.runId,
      codexThreadId: spec.threadId,
      codexTurnId: spec.turnId,
      itemId: spec.itemId ?? null,
      sequence: this.sequence,
      direction: spec.direction ?? "from_codex",
      kind: spec.kind ?? "notification",
      method: spec.method,
      rpcId: spec.rpcId ?? null,
      payload: spec.payload,
      deltaCounts: spec.deltaCounts ?? null,
      at: spec.at,
      bodiesExpiredAt: spec.expiredAt ?? null,
    });
  }

  /**
   * A tool item's started and completed messages; a completed `null` is a stub too large to keep.
   * `expiredAt` stores both as the retention sweep leaves them: what the item was and how it
   * ended (`EXPIRED_ITEM_FIELDS`), without what it was given or gave back.
   */
  async item(
    base: { runId: string; threadId: string; turnId: string },
    item: Record<string, unknown> & { id: string },
    from: Date,
    durationMs: number,
    completed: Record<string, unknown> | null,
    expiredAt?: Date,
  ) {
    if (expiredAt) {
      const skeleton = (fields: Record<string, unknown>) => ({
        expired: true,
        threadId: base.threadId,
        turnId: base.turnId,
        item: Object.fromEntries(
          EXPIRED_ITEM_FIELDS.filter((key) => fields[key] !== undefined).map((key) => [
            key,
            fields[key],
          ]),
        ),
      });
      for (const [method, at, fields] of [
        ["item/started", from, { ...item, status: "inProgress" }],
        ["item/completed", plus(from, durationMs), { ...item, ...completed, durationMs }],
      ] as const)
        await this.event({
          ...base,
          at,
          method,
          itemId: item.id,
          payload: skeleton(fields),
          expiredAt,
        });
      return;
    }
    await this.event({
      ...base,
      at: from,
      method: "item/started",
      itemId: item.id,
      payload: {
        threadId: base.threadId,
        turnId: base.turnId,
        item: { ...item, status: "inProgress" },
      },
    });
    await this.event({
      ...base,
      at: plus(from, durationMs),
      method: "item/completed",
      itemId: item.id,
      payload: completed
        ? {
            threadId: base.threadId,
            turnId: base.turnId,
            item: { ...item, ...completed, durationMs },
          }
        : { omitted: "it was too large to store", size: 3_418_204 },
    });
  }
}

/* ------------------------------------------------------------------ The story's shared parts */

// Kit's folder on the computer, where Codex runs as its system user.
export const KIT_HOME = "/home/bot/bots/kit";
export const SANDBOX = `<permissions instructions>Commands run in a sandbox. Ask before writing outside ${KIT_HOME}.</permissions instructions>`;

export type RunRef = { id: string; at: Date; completedAt: Date | null };

export const INSTRUCTIONS = [
  "You are Kit, a software engineer on Alex's team. You work on a shared Linux computer, in your own folder.",
  "",
  "## How you work",
  "- Reproduce a bug in a test before you fix it, and run the whole suite before you say it is done.",
  "- Keep changes small and explain them in plain words. Never push or deploy without asking.",
  "- Ask before anything risky: deleting files, spending money, or writing outside your workspace.",
  "",
  "## Tools",
  "Call tools from JavaScript in `exec`. `tools.exec_command` runs a shell command, `tools.apply_patch` edits files, and open-bot's own tools (tasks, pages, the chat title) are under `tools`.",
  "",
  // A long instructions body, as real teammates have: their team, their projects and their rules.
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `- Project note ${i + 1}: tidepool's recurrence code keeps every time in UTC and converts to the rule's zone only at the edges. Tests live next to the code and run with \`pnpm vitest run\`.`,
  ),
].join("\n");

export const TOOLS = [
  {
    type: "custom",
    name: "exec",
    description:
      "Run JavaScript that calls tools. Each call returns when the script ends or yields, with its output.",
    format: { type: "grammar", syntax: "lark", definition: "start: /.+/s" },
  },
  {
    type: "function",
    name: "wait",
    description: "Wait for a running code cell to yield again or finish.",
    parameters: {
      type: "object",
      properties: { cell_id: { type: "string" }, yield_time_ms: { type: "number" } },
      required: ["cell_id"],
    },
  },
];

/** A time a fraction of the way through a run, from when its turn could start to its end. */
export function span(run: RunRef) {
  const start = plus(run.at, 1800);
  const end = run.completedAt ?? plus(start, 60_000);
  const total = end.getTime() - start.getTime();
  return (fraction: number) => plus(start, Math.round(total * fraction));
}
