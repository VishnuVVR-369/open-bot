import { createHash, randomUUID } from "node:crypto";
import type { testDatabase } from "@open-bot/db/testing";
import { owned } from "./seed";

type TestDatabase = ReturnType<typeof testDatabase>;

/**
 * Model logs as the worker writes them, for API suites: runs, their turns, requests with their
 * items stored by hash, tool calls, and Codex messages.
 */
export class LogSeed {
  private sequence = Date.now() * 1000;

  constructor(private readonly database: TestDatabase) {}

  private async s() {
    return import("@open-bot/db");
  }

  async blob(value: unknown, kind: "item" | "instructions" | "tools" = "item") {
    const s = await this.s();
    const content = JSON.stringify(value);
    const hash = createHash("sha256").update(content).digest("hex");
    await this.database.db
      .insert(s.modelBlobs)
      .values({ hash, kind, content, bytes: Buffer.byteLength(content) })
      .onConflictDoNothing();
    return hash;
  }

  async teammate(name: string) {
    const s = await this.s();
    const id = randomUUID();
    const teammates = s.bots; // vocabulary: allow
    await this.database.db.insert(teammates).values({
      id,
      name,
      slug: `${name.toLowerCase()}-${id.slice(0, 6)}`,
      role: "Tester",
      color: "#0ea5e9",
    });
    return id;
  }

  async chat(teammateId: string, title: string) {
    const s = await this.s();
    const id = randomUUID();
    await this.database.db
      .insert(s.chats)
      .values({ id, kind: "direct", title, ...owned(teammateId) });
    return id;
  }

  /** A run with one turn on a thread of its own. */
  async run(spec: {
    teammateId: string;
    chatId: string;
    at: Date;
    status?: "completed" | "failed" | "interrupted" | "running";
    access?: "plan" | "api_key";
    id?: string;
  }) {
    const s = await this.s();
    const id = spec.id ?? randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    const status = spec.status ?? "completed";
    await this.database.db.insert(s.runs).values({
      id,
      chatId: spec.chatId,
      ...owned(spec.teammateId),
      trigger: "user",
      prompt: "Go",
      status,
      createdAt: spec.at,
      startedAt: spec.at,
      completedAt: status === "running" ? null : new Date(spec.at.getTime() + 60_000),
    });
    await this.database.db.insert(s.runTurns).values({
      runId: id,
      codexThreadId: threadId,
      codexTurnId: turnId,
      accessMode: spec.access ?? "plan",
      startedAt: new Date(spec.at.getTime() + 1000),
    });
    return { id, threadId, turnId };
  }

  /** A request with its input and output items, tool calls read from its output. */
  async request(spec: {
    threadId: string | null;
    turnId: string | null;
    teammateId?: string | null;
    at: Date;
    kind?: string;
    route?: "plan" | "api" | null;
    source?: "codex" | "memory";
    model?: string;
    status?: number | null;
    error?: string;
    input?: unknown[];
    output?: unknown[];
    responseText?: string | null;
    tokens?: { input: number; cached: number; output: number; reasoning?: number };
    costMicros?: number;
    rateLimits?: Record<string, string>;
    instructions?: string;
    tools?: unknown[];
    expiredAt?: Date;
    firstByteMs?: number;
    endpoint?: string;
    /** The request's parameters as stored, when not the plain model and stream. */
    params?: Record<string, unknown>;
  }) {
    const s = await this.s();
    const id = randomUUID();
    const calls = (spec.output ?? []).flatMap((item, position) => {
      const record = item as Record<string, unknown>;
      return record.type === "function_call" || record.type === "custom_tool_call"
        ? [
            {
              requestId: id,
              position,
              callId: String(record.call_id),
              type: String(record.type),
              name: String(record.name),
              arguments: String(record.arguments ?? record.input ?? ""),
            },
          ]
        : [];
    });
    await this.database.db.insert(s.modelRequests).values({
      id,
      source: spec.source ?? "codex",
      route: spec.route === undefined ? "plan" : spec.route,
      transport: "http",
      method: "POST",
      endpoint: spec.endpoint ?? "/responses",
      codexThreadId: spec.threadId,
      codexTurnId: spec.turnId,
      requestKind: spec.kind ?? "turn",
      teammateId: spec.teammateId ?? null,
      model: spec.model ?? "gpt-5.5",
      status: spec.status === undefined ? 200 : spec.status,
      errorMessage: spec.error ?? null,
      startedAt: spec.at,
      firstByteAt: new Date(spec.at.getTime() + (spec.firstByteMs ?? 200)),
      endedAt: new Date(spec.at.getTime() + 2000),
      inputTokens: spec.tokens?.input ?? null,
      cachedInputTokens: spec.tokens?.cached ?? null,
      outputTokens: spec.tokens?.output ?? null,
      reasoningTokens: spec.tokens?.reasoning ?? null,
      costMicros: spec.costMicros ?? 0,
      requestHeaders: { "content-type": "application/json" },
      rateLimitHeaders: spec.rateLimits ?? null,
      params: spec.params ?? { model: spec.model ?? "gpt-5.5", stream: true },
      instructionsHash: spec.instructions
        ? await this.blob(spec.instructions, "instructions")
        : null,
      toolsHash: spec.tools ? await this.blob(spec.tools, "tools") : null,
      responseText: spec.responseText ?? null,
      bodiesExpiredAt: spec.expiredAt ?? null,
    });
    if (!spec.expiredAt)
      for (const [side, items] of [
        ["input", spec.input ?? []],
        ["output", spec.output ?? []],
      ] as const)
        for (const [position, item] of items.entries())
          await this.database.db.insert(s.modelRequestItems).values({
            requestId: id,
            side,
            position,
            blobHash: await this.blob(item),
          });
    if (calls.length)
      await this.database.db
        .insert(s.modelToolCalls)
        .values(spec.expiredAt ? calls.map((call) => ({ ...call, arguments: null })) : calls);
    return id;
  }

  /**
   * A tool item's started and completed messages. `omitted` stores the completed one as the
   * worker does a message too large to keep.
   */
  async item(spec: {
    runId: string;
    threadId: string;
    turnId: string;
    item: Record<string, unknown> & { id: string; type: string };
    at: Date;
    ms: number;
    completed: Record<string, unknown>;
    omitted?: boolean;
    expiredAt?: Date;
  }) {
    const s = await this.s();
    for (const [method, when, item] of [
      ["item/started", spec.at, { ...spec.item, status: "inProgress" }],
      [
        "item/completed",
        new Date(spec.at.getTime() + spec.ms),
        { ...spec.item, ...spec.completed },
      ],
    ] as const) {
      this.sequence += 1;
      await this.database.db.insert(s.codexEvents).values({
        runId: spec.runId,
        codexThreadId: spec.threadId,
        codexTurnId: spec.turnId,
        itemId: spec.item.id,
        sequence: this.sequence,
        direction: "from_codex",
        kind: "notification",
        method,
        payload:
          spec.omitted && method === "item/completed"
            ? { omitted: "too large", size: 9_000_000 }
            : { threadId: spec.threadId, turnId: spec.turnId, item },
        at: when,
        bodiesExpiredAt: spec.expiredAt ?? null,
      });
    }
  }
}

export const message = (role: "user" | "assistant", text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});

export const functionCall = (callId: string, name: string, args: unknown) => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});

export const execCall = (callId: string, code: string) => ({
  type: "custom_tool_call",
  call_id: callId,
  name: "exec",
  input: code,
});
