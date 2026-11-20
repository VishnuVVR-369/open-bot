import { createHash, randomUUID } from "node:crypto";
import {
  teammates,
  chats,
  codexEvents,
  modelBlobs,
  modelRequestItems,
  modelRequests,
  modelToolCalls,
  runs,
  settings,
} from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { modelBlob } from "@open-bot/domain/server";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequestRecord } from "./capture";
import { ModelLogRetention, type RetentionOptions } from "./retention";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const DAY = 24 * 60 * 60_000;
const quiet = { info() {}, warn() {} };

describe.skipIf(!url)("model log retention sweep", () => {
  const database = testDatabase(url);
  const { db, pool } = database;
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  let runId: string;

  const sweeper = (options: Partial<RetentionOptions> = {}) =>
    new ModelLogRetention(pool, quiet, { now: () => now, pauseMs: 0, ...options });

  async function blob(content: string, kind: "item" | "instructions" | "tools" = "item") {
    const text = JSON.stringify(content);
    const hash = createHash("sha256").update(text).digest("hex");
    // Blobs are as old as the request that first sent them.
    await db
      .insert(modelBlobs)
      .values({ hash, kind, content: text, bytes: text.length, createdAt: ago(60) })
      .onConflictDoNothing();
    return hash;
  }

  /** A request with its items, instructions, a tool call and a response. */
  async function request(startedAt: Date, items: string[], instructions: string) {
    const id = randomUUID();
    await db.insert(modelRequests).values({
      id,
      source: "codex",
      route: "api",
      transport: "http",
      method: "POST",
      endpoint: "/responses",
      codexThreadId: "th",
      codexTurnId: randomUUID(),
      startedAt,
      status: 200,
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 90,
      costMicros: 4321,
      requestHeaders: { "content-type": "application/json" },
      instructionsHash: instructions,
      responseText: "The answer",
      reasoningSummary: "Thought about it",
      params: { model: "gpt-5.5" },
    });
    await db.insert(modelRequestItems).values(
      items.map((blobHash, position) => ({
        requestId: id,
        side: "input" as const,
        position,
        blobHash,
      })),
    );
    await db.insert(modelToolCalls).values({
      requestId: id,
      position: 0,
      callId: `call_${id}`,
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"cat secrets.txt"}',
    });
    return id;
  }

  async function event(at: Date, item: Record<string, unknown>) {
    const id = randomUUID();
    await db.insert(codexEvents).values({
      id,
      runId,
      codexThreadId: "th",
      codexTurnId: "tu",
      itemId: String(item.id),
      sequence: at.getTime() * 1000,
      direction: "from_codex",
      kind: "notification",
      method: "item/completed",
      payload: { threadId: "th", turnId: "tu", item },
      at,
    });
    return id;
  }

  const setRetention = (days: number | null) =>
    db
      .insert(settings)
      .values({ id: 1, modelLogRetentionDays: days })
      .onConflictDoUpdate({ target: settings.id, set: { modelLogRetentionDays: days } });

  const blobExists = async (hash: string) =>
    (await db.select().from(modelBlobs).where(eq(modelBlobs.hash, hash))).length === 1;

  const requestRow = async (id: string) =>
    (await db.select().from(modelRequests).where(eq(modelRequests.id, id)))[0]!;

  const itemCount = async (id: string) =>
    (await db.select().from(modelRequestItems).where(eq(modelRequestItems.requestId, id))).length;

  beforeAll(async () => {
    await database.create();
    const teammateId = randomUUID();
    const chatId = randomUUID();
    runId = randomUUID();
    await db
      .insert(teammates)
      .values({ id: teammateId, name: "Kit", slug: "kit", role: "engineer", color: "#000000" });
    await db.insert(chats).values({ id: chatId, kind: "direct", title: "Sweep", teammateId });
    await db.insert(runs).values({
      id: runId,
      chatId,
      teammateId,
      trigger: "user",
      prompt: "p",
      status: "completed",
    });
  });
  afterAll(() => database.drop());

  beforeEach(async () => {
    await db.delete(modelRequests);
    await db.delete(modelBlobs);
    await db.delete(codexEvents);
    await setRetention(30);
  });

  it("removes exactly the expired bodies and the blobs only they named, and keeps every number", async () => {
    const shared = await blob("the conversation so far");
    const onlyOld = await blob("an old message");
    const onlyNew = await blob("a new message");
    const oldInstructions = await blob("Old instructions", "instructions");
    const instructions = await blob("Instructions", "instructions");
    const old = await request(ago(40), [shared, onlyOld], oldInstructions);
    const recent = await request(ago(1), [shared, onlyNew], instructions);
    const oldEvent = await event(ago(40), {
      type: "commandExecution",
      id: "cmd_1",
      command: "cat secrets.txt",
      aggregatedOutput: "hunter2",
      status: "failed",
      exitCode: 1,
      durationMs: 812,
      error: { message: "x".repeat(1000), data: "secret detail" },
    });
    const newEvent = await event(ago(1), { type: "commandExecution", id: "cmd_2", command: "ls" });

    const result = await sweeper().sweep();
    expect(result).toMatchObject({ skipped: null, requests: 1, events: 1, interrupted: false });
    expect(result.blobs).toBe(2);

    // The old request: bodies gone, numbers and links kept.
    const expired = await requestRow(old);
    expect(expired.bodiesExpiredAt).toEqual(now);
    expect(expired).toMatchObject({
      status: 200,
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 90,
      costMicros: 4321,
      codexThreadId: "th",
      responseText: null,
      reasoningSummary: null,
      instructionsHash: null,
      params: { model: "gpt-5.5" },
    });
    expect(await itemCount(old)).toBe(0);
    const [call] = await db.select().from(modelToolCalls).where(eq(modelToolCalls.requestId, old));
    expect(call).toMatchObject({ name: "exec_command", callId: `call_${old}`, arguments: null });

    // The recent request is untouched.
    const kept = await requestRow(recent);
    expect(kept).toMatchObject({ bodiesExpiredAt: null, responseText: "The answer" });
    expect(kept.instructionsHash).toBe(instructions);
    expect(await itemCount(recent)).toBe(2);

    // Blobs: only those nothing names any more are gone.
    expect(await blobExists(onlyOld)).toBe(false);
    expect(await blobExists(oldInstructions)).toBe(false);
    expect(await blobExists(shared)).toBe(true);
    expect(await blobExists(onlyNew)).toBe(true);
    expect(await blobExists(instructions)).toBe(true);

    // The old message keeps its item's status, exit code and duration, a short error, no body.
    const [cut] = await db.select().from(codexEvents).where(eq(codexEvents.id, oldEvent));
    expect(cut!.bodiesExpiredAt).toEqual(now);
    expect(cut!.payload).toEqual({
      expired: true,
      threadId: "th",
      turnId: "tu",
      item: {
        type: "commandExecution",
        id: "cmd_1",
        status: "failed",
        exitCode: 1,
        durationMs: 812,
        error: { message: "x".repeat(300) },
      },
    });
    const [untouched] = await db.select().from(codexEvents).where(eq(codexEvents.id, newEvent));
    expect(untouched!.bodiesExpiredAt).toBeNull();
    expect(untouched!.payload).toMatchObject({ item: { command: "ls" } });

    // A second sweep finds nothing left to do.
    expect(await sweeper().sweep()).toMatchObject({ requests: 0, events: 0, blobs: 0 });
  });

  it("expires the parameters that carry text, for a scalar input and a side request", async () => {
    const scalar = await request(
      ago(40),
      [await blob("an earlier turn")],
      await blob("I", "instructions"),
    );
    await db
      .update(modelRequests)
      .set({
        params: {
          model: "gpt-5",
          input: "private retention example",
          stream: true,
          reasoning: { effort: "high", summary: "auto" },
          text: { verbosity: "low", format: { type: "json_schema", name: "private schema" } },
          metadata: { note: "private note" },
        },
      })
      .where(eq(modelRequests.id, scalar));
    const side = randomUUID();
    await db.insert(modelRequests).values({
      id: side,
      source: "memory",
      route: "api",
      transport: "http",
      method: "POST",
      endpoint: "https://api.openai.com/v1/chat/completions",
      requestKind: "extraction",
      startedAt: ago(40),
      status: 200,
      inputTokens: 300,
      outputTokens: 40,
      costMicros: 120,
      requestHeaders: {},
      responseText: "private facts",
      params: {
        model: "gpt-5-mini",
        prompt: "private prompt",
        response_format: { type: "json_object" },
        max_completion_tokens: 800,
        user: "private user",
      },
    });

    expect(await sweeper().sweep()).toMatchObject({ requests: 2 });
    const expired = await requestRow(scalar);
    expect(expired.params).toEqual({
      model: "gpt-5",
      stream: true,
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "low" },
    });
    const memory = await requestRow(side);
    expect(memory.params).toEqual({ model: "gpt-5-mini", max_completion_tokens: 800 });
    expect(memory).toMatchObject({ responseText: null, inputTokens: 300, costMicros: 120 });
    expect(JSON.stringify([expired, memory])).not.toContain("private");
  });

  it("works in batches, oldest first", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        await request(ago(50 - i), [await blob(`message ${i}`)], await blob("I", "instructions")),
      );
    const batches: { kind: string; rows: number }[] = [];
    const result = await sweeper({ requestBatch: 2, onBatch: (b) => batches.push(b) }).sweep();
    expect(result.requests).toBe(5);
    expect(batches.filter((b) => b.kind === "requests").map((b) => b.rows)).toEqual([2, 2, 1]);
    expect(result.blobs).toBe(6);
  });

  it("can be stopped between batches and goes on from there next time, leaving nothing half done", async () => {
    const fresh = [];
    for (let i = 0; i < 5; i++)
      fresh.push(
        await request(ago(50 - i), [await blob(`again ${i}`)], await blob("J", "instructions")),
      );
    const interrupted = sweeper({ requestBatch: 2, onBatch: () => void interrupted.stop() });
    const partial = await interrupted.sweep();
    expect(partial).toMatchObject({ interrupted: true, requests: 2 });
    // Each request is either whole or fully expired, never in between.
    for (const [i, id] of fresh.entries()) {
      const row = await requestRow(id);
      const expired = row.bodiesExpiredAt !== null;
      expect(expired, `request ${i}`).toBe(i < 2);
      expect(await itemCount(id)).toBe(expired ? 0 : 1);
      expect(row.responseText === null).toBe(expired);
    }
    expect(
      await blobExists(createHash("sha256").update(JSON.stringify("again 0")).digest("hex")),
    ).toBe(false);
    expect(
      await blobExists(createHash("sha256").update(JSON.stringify("again 4")).digest("hex")),
    ).toBe(true);

    const resumed = await sweeper({ requestBatch: 2 }).sweep();
    expect(resumed).toMatchObject({ interrupted: false, requests: 3 });
    const left = await db
      .select()
      .from(modelRequests)
      .where(sql`${modelRequests.bodiesExpiredAt} is null`);
    expect(left).toEqual([]);
    expect(await db.select().from(modelBlobs)).toEqual([]);
  });

  it("never runs twice at once, in one worker or across two", async () => {
    await request(ago(40), [await blob("one")], await blob("I", "instructions"));
    const one = sweeper();
    expect(one.sweep()).toBe(one.sweep());
    await one.sweep();

    await request(ago(40), [await blob("two")], await blob("I", "instructions"));
    // Another worker holds the lock: this one skips, touching nothing.
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtextextended('model_log_retention', 0))");
      expect(await sweeper().sweep()).toMatchObject({ skipped: "busy", requests: 0 });
    } finally {
      await holder.query("select pg_advisory_unlock(hashtextextended('model_log_retention', 0))");
      holder.release();
    }
    expect(await sweeper().sweep()).toMatchObject({ skipped: null, requests: 1 });
  });

  it("keeps everything when bodies are kept forever", async () => {
    await setRetention(null);
    const id = await request(ago(400), [await blob("ancient")], await blob("I", "instructions"));
    expect(await sweeper().sweep()).toMatchObject({ skipped: "forever", requests: 0 });
    expect((await requestRow(id)).bodiesExpiredAt).toBeNull();
    expect(await itemCount(id)).toBe(1);
  });

  it("never deletes a blob the writer is naming, and frees it on a later sweep if nothing does", async () => {
    const reused = await blob("reused by the writer");
    await request(ago(40), [reused], await blob("I", "instructions"));
    // The writer has looked the blob up and locked it, and hasn't committed yet.
    const writer = await pool.connect();
    await writer.query("begin");
    await writer.query("select hash from model_blobs where hash = $1 for key share", [reused]);
    try {
      const result = await sweeper().sweep();
      expect(result.requests).toBe(1);
      expect(await blobExists(reused)).toBe(true);
    } finally {
      await writer.query("rollback");
      writer.release();
    }
    // The writer gave up on it; the next sweep's last pass finds it named by nothing.
    expect(await sweeper().sweep()).toMatchObject({ requests: 0, blobs: 1 });
    expect(await blobExists(reused)).toBe(false);
  });

  it("lets the writer name a blob the sweep deleted, by writing it again", async () => {
    const item = modelBlob("item", { type: "message", role: "user", content: "said again" });
    await db.insert(modelBlobs).values({ ...item, bytes: item.content.length, createdAt: ago(60) });
    await request(ago(40), [item.hash], await blob("I", "instructions"));
    await sweeper().sweep();
    expect(await blobExists(item.hash)).toBe(false);

    const writer = new ModelLogWriter(db, { warn() {}, error() {} }, { flushMs: 5, batchRows: 1 });
    writer.start();
    const record: ModelRequestRecord = {
      row: {
        id: randomUUID(),
        source: "codex",
        route: "api",
        transport: "http",
        method: "POST",
        endpoint: "/responses",
        startedAt: new Date(),
        requestHeaders: {},
      },
      blobs: [item],
      items: [{ side: "input", position: 0, blobHash: item.hash }],
      toolCalls: [],
      bytes: 100,
    };
    writer.add(record);
    await writer.stop();
    expect(await blobExists(item.hash)).toBe(true);
    expect(await itemCount(record.row.id)).toBe(1);
    expect(
      await db
        .select()
        .from(modelRequestItems)
        .where(inArray(modelRequestItems.blobHash, [item.hash])),
    ).toHaveLength(1);
  });
});
