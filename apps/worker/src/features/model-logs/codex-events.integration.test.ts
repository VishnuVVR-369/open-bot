// The Codex event tap end to end: the worker's real CodexClient talks JSON-RPC to a stand-in
// app-server, the tap queues every message on the real writer, and rows land in Postgres.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CodexClient } from "@open-bot/agent";
import {
  teammates,
  chats,
  codexEvents,
  createDb,
  createPool,
  modelLogGaps,
  modelRequests,
  runs,
  runTurns,
} from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { type AuthMode, rebuildResponse } from "@open-bot/domain";
import { MemoryAI } from "@open-bot/memory/jobs";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentRunId, inRunScope } from "../../core/run-scope";
import { recordExchange } from "./capture";
import { CodexEventTap } from "./codex-events";
import { memoryRequestObserver } from "./memory";
import { AppServerStandIn, exchange, linksOf } from "./codex-events.testing";
import { DatabaseRelay } from "./testing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();

/** Secrets that pass through the stream and must never be stored. */
const ACCESS_TOKEN =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE5MzQ0ZTY1In0.eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdfQ.c2lnbmF0dXJlLXRva2Vu";
const MCP_HEADER = "Bearer ghp_integrationSecretHeader01";
const MCP_ENV = "ntn_integration_secret_env_value";
const MEMORY_KEY = "sk-memory-integration-secret-0123456789";

/**
 * How long a test waits for the writer to save rows. `pnpm test:integration` runs every suite at
 * once against one Postgres, where a batch can take seconds to land: Vitest's default of one
 * second failed a test whose rows were on their way.
 */
const SAVED = { timeout: 10_000 };

/**
 * Each test's own limit, with room for a full `SAVED` wait and the work around it: Vitest stops a
 * test after 5 s by default, which would cut a wait for rows that land after 6 s.
 */
const WAITS_FOR_ROWS = { timeout: 20_000 };

describe.skipIf(!url)("Codex event tap", WAITS_FOR_ROWS, () => {
  const database = testDatabase(url);
  const { db } = database;
  const standIn = new AppServerStandIn();
  /** The live runs, as the session registry answers. */
  const live = new Map<string, { thread: string | null; mode: AuthMode }>();
  let relay: DatabaseRelay;
  let writerPool: ReturnType<typeof createPool>;
  let writer: ModelLogWriter;
  let tap: CodexEventTap;
  let client: CodexClient;
  let teammateId: string;
  let chatId: string;

  beforeAll(async () => {
    await database.create();
    await standIn.listening;
    const relayUrl = new URL(database.url);
    relay = new DatabaseRelay({ host: relayUrl.hostname, port: Number(relayUrl.port) });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    relayUrl.host = `127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
    // The relay cuts the writer's connections on purpose, as an outage does.
    writerPool = createPool(relayUrl.toString(), { onIdleError: () => {} });
    writer = new ModelLogWriter(
      createDb(writerPool),
      { warn() {}, error() {} },
      { flushMs: 5, retryForMs: 60_000, backoffMs: 5, maxBackoffMs: 20 },
    );
    tap = new CodexEventTap({
      writer,
      runs: {
        runForThread: (threadId) => {
          for (const [runId, run] of live)
            if (run.thread === threadId) return { runId, accessMode: run.mode };
          return null;
        },
        accessMode: (runId) => live.get(runId)?.mode ?? null,
      },
      currentRunId,
    });
    client = await CodexClient.connect(
      standIn.url,
      async (request) => {
        if (request.method === "item/tool/call")
          return { success: true, contentItems: [{ type: "inputText", text: "Sent." }] };
        if (request.method === "account/chatgptAuthTokens/refresh")
          return { accessToken: ACCESS_TOKEN, chatgptAccountId: "acct-int", chatgptPlanType: null };
        return {};
      },
      undefined,
      undefined,
      tap.connection(),
    );
    const [teammate] = await db
      .insert(teammates)
      .values({ name: "Iris", slug: "iris", role: "assistant", color: "violet" })
      .returning();
    teammateId = teammate!.id;
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: "Tap", teammateId })
      .returning();
    chatId = chat!.id;
  });

  afterAll(async () => {
    client?.close();
    await writer?.stop();
    await writerPool?.end();
    standIn.server.close();
    relay?.server.close();
    await database.drop();
  });

  beforeEach(() => {
    live.clear();
    relay.up();
  });

  async function newRun(): Promise<string> {
    const [run] = await db
      .insert(runs)
      .values({
        chatId,
        teammateId,
        trigger: "user",
        prompt: "List files",
        status: "running",
      })
      .returning();
    return run!.id;
  }

  /** How many messages of a run are saved. */
  async function saved(runId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(codexEvents)
      .where(eq(codexEvents.runId, runId));
    return row!.count;
  }

  /**
   * One turn as a session runs it, in the run's scope: thread/start with MCP servers' secrets in
   * its config, then turn/start. The stand-in answers like Codex.
   */
  async function startTurn(runId: string, thread: string, turn: string, mode: AuthMode) {
    live.set(runId, { thread: live.get(runId)?.thread ?? null, mode });
    standIn.onMessage = (message) => {
      if (message.method === "thread/start") {
        standIn.send({ id: message.id, result: { thread: { id: thread } } });
        standIn.notify("thread/started", { thread: { id: thread } });
      } else if (message.method === "turn/start") {
        standIn.notify("turn/started", { threadId: thread, turn: { id: turn } });
        standIn.send({ id: message.id, result: { turn: { id: turn, status: "inProgress" } } });
      }
    };
    // Codex answers thread/start before announcing the thread; a session goes on to turn/start
    // without waiting, so the test waits for the announcement to keep the order it checks fixed.
    const announced = new Promise<void>((resolve) => {
      const listener = (notification: { method: string }) => {
        if (notification.method !== "thread/started") return;
        client.off("notification", listener);
        resolve();
      };
      client.on("notification", listener);
    });
    await inRunScope(runId, async () => {
      const started = await client.request("thread/start", {
        cwd: "/home/bot/work/iris",
        config: {
          mcp_servers: {
            github: {
              url: "https://mcp.example.com/mcp",
              http_headers: { Authorization: MCP_HEADER },
            },
            notion: { command: "npx", args: ["notion-mcp"], env: { NOTION_TOKEN: MCP_ENV } },
          },
        },
      } as never);
      live.get(runId)!.thread = started.thread.id;
      await announced;
      await client.request("turn/start", { threadId: started.thread.id, input: [] } as never);
    });
  }

  it("saves a run's messages with their run, counts deltas instead, and stores no secret", async () => {
    // Signing in belongs to no run, and carries the computer's ChatGPT token.
    standIn.onMessage = (message) => standIn.send({ id: message.id, result: {} });
    await client.request("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: ACCESS_TOKEN,
      chatgptAccountId: "acct-int",
    });

    const runId = await newRun();
    await startTurn(runId, "thr-a", "turn-a", "plan");
    const at = { threadId: "thr-a", turnId: "turn-a" };
    for (const delta of ["Lis", "ted", " files"])
      standIn.notify("item/agentMessage/delta", { ...at, itemId: "msg_1", delta });
    standIn.notify("item/completed", {
      ...at,
      item: { type: "agentMessage", id: "msg_1", text: "Listed files" },
    });
    standIn.send({
      id: 0,
      method: "item/tool/call",
      params: { ...at, callId: "call_dyn", namespace: null, tool: "send_message", arguments: {} },
    });
    standIn.send({
      id: 1,
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "acct-int" },
    });
    await expect.poll(() => standIn.answers.size).toBe(2);
    standIn.notify("turn/completed", { threadId: "thr-a", turn: { id: "turn-a" } });

    // Everything of the run: thread/start both ways, thread/started, turn/start both ways,
    // turn/started, item/completed, the tool call both ways and turn/completed.
    await expect.poll(() => saved(runId), SAVED).toBe(10);
    const rows = await db
      .select()
      .from(codexEvents)
      .where(eq(codexEvents.runId, runId))
      .orderBy(asc(codexEvents.sequence));
    expect(rows.map((row) => `${row.direction} ${row.kind} ${row.method}`)).toEqual([
      "to_codex request thread/start",
      "from_codex response thread/start",
      "from_codex notification thread/started",
      "to_codex request turn/start",
      "from_codex notification turn/started",
      "from_codex response turn/start",
      "from_codex notification item/completed",
      "from_codex request item/tool/call",
      "to_codex response item/tool/call",
      "from_codex notification turn/completed",
    ]);
    expect(rows.find((row) => row.method === "item/completed")?.deltaCounts).toEqual({
      msg_1: { "item/agentMessage/delta": 3 },
    });
    expect(rows.filter((row) => row.method === "item/tool/call").map((row) => row.itemId)).toEqual([
      "call_dyn",
      "call_dyn",
    ]);
    const [deltas] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(codexEvents)
      .where(sql`${codexEvents.method} ilike '%delta'`);
    expect(deltas!.count).toBe(0);

    // The sign-in and the refresh are saved too, with no run, redacted.
    await expect
      .poll(async () =>
        (await db.select().from(codexEvents)).filter((row) => row.method.startsWith("account/")),
      )
      .toHaveLength(4);
    const everything = (
      await database.pool.query<{ text: string }>(
        "select coalesce(string_agg(payload::text, ' '), '') as text from codex_events",
      )
    ).rows[0]!.text;
    for (const secret of [ACCESS_TOKEN.slice(0, 24), "acct-int", MCP_HEADER, "ghp_", MCP_ENV])
      expect(everything).not.toContain(secret);
    expect(everything).toContain("[redacted]");
  });

  it("records both turns of a run that fell back from the plan to the API key", async () => {
    const runId = await newRun();
    await startTurn(runId, "thr-plan", "turn-plan", "plan");
    await startTurn(runId, "thr-key", "turn-key", "api_key");
    await expect
      .poll(async () => (await db.select().from(runTurns).where(eq(runTurns.runId, runId))).length)
      .toBe(2);
    const turns = await db
      .select({
        thread: runTurns.codexThreadId,
        turn: runTurns.codexTurnId,
        mode: runTurns.accessMode,
      })
      .from(runTurns)
      .where(eq(runTurns.runId, runId))
      .orderBy(asc(runTurns.startedAt));
    expect(turns).toEqual([
      { thread: "thr-plan", turn: "turn-plan", mode: "plan" },
      { thread: "thr-key", turn: "turn-key", mode: "api_key" },
    ]);
  });

  it("joins a tool call the model made to its outcome in the app-server stream", async () => {
    const runId = await newRun();
    await startTurn(runId, "thr-join", "turn-join", "plan");
    // The model's response, as the proxy captured it: one shell call.
    const output = [
      {
        type: "function_call",
        id: "fc_1",
        name: "exec_command",
        arguments: '{"cmd":"ls"}',
        call_id: "call_shell",
      },
    ];
    const record = await recordExchange(
      {
        route: "plan",
        transport: "http",
        method: "POST",
        endpoint: "/responses",
        teammateId,
        requestHeaders: {},
        requestBody: null,
        requestJson: {
          model: "gpt-6.1-sol",
          input: [],
          client_metadata: { thread_id: "thr-join", turn_id: "turn-join" },
        },
        requestBytes: 0,
        sent: true,
        status: 200,
        responseHeaders: { "content-type": "application/json" },
        response: rebuildResponse(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            model: "gpt-6.1-sol",
            status: "completed",
            output,
          }),
          "application/json",
        ),
        rawResponse: null,
        responseBytes: 0,
        startedAt: new Date(),
        firstByteAt: new Date(),
        endedAt: new Date(),
        failure: null,
        warnings: [],
      },
      randomUUID(),
    );
    writer.add(record);
    // Codex runs the call: its item is named by the call id.
    standIn.notify("item/completed", {
      threadId: "thr-join",
      turnId: "turn-join",
      item: {
        type: "commandExecution",
        id: "call_shell",
        command: "ls",
        status: "completed",
        exitCode: 0,
        durationMs: 12,
      },
    });
    const join = () =>
      database.pool.query<{ name: string; status: string; exit_code: number; run_id: string }>(
        `select c.name, e.payload->'item'->>'status' as status,
                (e.payload->'item'->>'exitCode')::int as exit_code, e.run_id
         from model_tool_calls c
         join model_requests r on r.id = c.request_id
         join codex_events e on e.codex_thread_id = r.codex_thread_id and e.item_id = c.call_id
         where e.method = 'item/completed'`,
      );
    await expect.poll(async () => (await join()).rows, SAVED).toHaveLength(1);
    expect((await join()).rows[0]).toEqual({
      name: "exec_command",
      status: "completed",
      exit_code: 0,
      run_id: runId,
    });
  });

  it("links a code-mode cell's nested items to it as a candidate, never exactly", async () => {
    const runId = await newRun();
    await startTurn(runId, "thr-cell", "turn-cell", "plan");
    const now = Date.now();
    const exec = {
      type: "custom_tool_call",
      call_id: "call_cell",
      name: "exec",
      input: "await tools.exec_command({cmd: 'ls'}); await tools.send_message({text: 'hi'});",
    };
    // The response is still streaming when the cell starts its nested calls, which arrive now.
    writer.add(
      await exchange(teammateId, "thr-cell", "turn-cell", [], [exec], {
        startedAt: new Date(now - 10_000),
        firstByteAt: new Date(now - 9_000),
        endedAt: new Date(now + 60_000),
      }),
    );
    const at = { threadId: "thr-cell", turnId: "turn-cell" };
    standIn.notify("item/started", {
      ...at,
      item: { type: "commandExecution", id: "exec-11111111", command: "ls", status: "inProgress" },
    });
    standIn.send({
      id: 7,
      method: "item/tool/call",
      params: {
        ...at,
        callId: "exec-22222222",
        namespace: null,
        tool: "send_message",
        arguments: {},
      },
    });
    await expect.poll(() => standIn.answers.has(7)).toBe(true);
    standIn.notify("item/completed", {
      ...at,
      item: {
        type: "dynamicToolCall",
        id: "exec-22222222",
        tool: "send_message",
        status: "completed",
      },
    });
    standIn.notify("item/completed", {
      ...at,
      item: { type: "commandExecution", id: "exec-11111111", status: "completed", exitCode: 0 },
    });
    // The next request carries the cell's result.
    writer.add(
      await exchange(
        teammateId,
        "thr-cell",
        "turn-cell",
        [
          exec,
          {
            type: "custom_tool_call_output",
            call_id: "call_cell",
            output: "Script completed\nWall time 0.2 seconds\nOutput:\n",
          },
        ],
        [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }],
        {
          startedAt: new Date(now + 61_000),
          firstByteAt: new Date(now + 62_000),
          endedAt: new Date(now + 63_000),
        },
      ),
    );
    await expect.poll(async () => (await linksOf(database.pool, "thr-cell")).length, SAVED).toBe(2);
    expect(await linksOf(database.pool, "thr-cell")).toEqual([
      expect.objectContaining({
        itemId: "exec-11111111",
        match: "only_candidate",
        callIds: ["call_cell"],
      }),
      expect.objectContaining({
        itemId: "exec-22222222",
        match: "only_candidate",
        callIds: ["call_cell"],
      }),
    ]);
  });

  it("never holds up JSON-RPC while the database can't be reached", async () => {
    const runId = await newRun();
    relay.down();
    const failed = once(writer, "failed");
    await startTurn(runId, "thr-down", "turn-down", "plan");
    for (let index = 0; index < 50; index += 1)
      standIn.notify("item/completed", {
        threadId: "thr-down",
        turnId: "turn-down",
        item: { type: "agentMessage", id: `msg_${index}`, text: "still answering" },
      });
    // Requests keep getting answers while the writer fails to reach the database.
    standIn.onMessage = (message) => standIn.send({ id: message.id, result: { account: null } });
    await failed;
    for (let index = 0; index < 5; index += 1)
      await expect(client.request("account/read", {})).resolves.toEqual({ account: null });
    relay.up();
    // Once the database is back, what was queued is saved.
    await expect.poll(() => saved(runId), SAVED).toBeGreaterThanOrEqual(56);
    expect(await db.select().from(modelLogGaps)).toEqual([]);
  });

  it("stores stubs for messages too large or too deep, and counts them as lost", async () => {
    const runId = await newRun();
    await startTurn(runId, "thr-big", "turn-big", "plan");
    const at = { threadId: "thr-big", turnId: "turn-big" };
    // An MCP tool's result of about 8 MB, and an item nested 12,000 deep, written by hand since
    // serializing that deep would overflow here too.
    standIn.notify("item/completed", {
      ...at,
      item: {
        type: "mcpToolCall",
        id: "call_big",
        result: { content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] },
      },
    });
    const depth = 12_000;
    standIn.socket!.send(
      `{"method":"item/completed","params":{"threadId":"thr-big","turnId":"turn-big","item":{"id":"call_deep","nested":${'{"next":'.repeat(depth)}1${"}".repeat(depth)}}}}`,
    );
    // The connection keeps answering.
    standIn.onMessage = (message) => standIn.send({ id: message.id, result: { account: null } });
    await expect(client.request("account/read", {})).resolves.toEqual({ account: null });
    const stubs = () =>
      database.pool.query<{ item_id: string; payload: { omitted: string; size: number } }>(
        `select item_id, payload from codex_events
          where codex_thread_id = 'thr-big' and method = 'item/completed' order by sequence`,
      );
    await expect.poll(async () => (await stubs()).rows.length, SAVED).toBe(2);
    expect((await stubs()).rows).toEqual([
      {
        item_id: "call_big",
        payload: { omitted: "it was too large to store", size: expect.any(Number) },
      },
      {
        item_id: "call_deep",
        payload: { omitted: "it nests too deep", size: expect.any(Number) },
      },
    ]);
    const lostEvents = async () =>
      (
        await database.pool.query<{ events: number }>(
          "select coalesce(sum(codex_events), 0)::int as events from model_log_gaps",
        )
      ).rows[0]!.events;
    await expect.poll(lostEvents, SAVED).toBe(2);
  });

  it("saves a message observed right before shutdown, the tap drained before the writer stops", async () => {
    // Its own writer and tap, stopped in the worker's order: the tap drains, then the writer stops.
    const own = new ModelLogWriter(db, { warn() {}, error() {} }, { flushMs: 5 });
    let dropped = 0;
    own.on("dropped", (count) => (dropped += count));
    const ownTap = new CodexEventTap({
      writer: own,
      runs: { runForThread: () => null, accessMode: () => null },
      currentRunId: () => undefined,
    });
    const item = { id: "msg_last", type: "agentMessage", text: "Done." };
    const payload = { threadId: "thr-shutdown", item };
    ownTap.connection()({
      direction: "from_codex",
      kind: "notification",
      id: null,
      method: "item/completed",
      payload,
      size: JSON.stringify(payload).length,
    });
    expect(ownTap.pending).toBe(1);
    ownTap.drain();
    await own.stop();
    // Its deferred redaction, run after the writer stopped, finds nothing left to do.
    await new Promise((resolve) => setImmediate(resolve));
    const rows = await database.pool.query(
      "select item_id, payload from codex_events where codex_thread_id = 'thr-shutdown'",
    );
    expect(rows.rows).toEqual([{ item_id: "msg_last", payload }]);
    expect(dropped).toBe(0);
  });

  it("saves the memory AI's calls as model requests, without the API key", async () => {
    const stand: Server = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ embedding: [1, 0, 0] }], usage: { prompt_tokens: 3 } }),
      );
    });
    stand.listen(0, "127.0.0.1");
    await once(stand, "listening");
    try {
      const ai = new MemoryAI(
        db,
        {
          embeddingUrl: `http://127.0.0.1:${(stand.address() as AddressInfo).port}/v1/embeddings`,
          embeddingModel: "embed-test",
          embeddingDimensions: 3,
          extractionModel: "",
          apiKey: MEMORY_KEY,
          dailyRequestLimit: 100,
        },
        memoryRequestObserver(writer),
      );
      expect(await ai.embed("Prefers remote roles")).toEqual([1, 0, 0]);
      await expect
        .poll(async () => db.select().from(modelRequests).where(eq(modelRequests.source, "memory")))
        .toHaveLength(1);
      const [row] = await db.select().from(modelRequests).where(eq(modelRequests.source, "memory"));
      expect(row).toMatchObject({
        route: null,
        requestKind: "embedding",
        model: "embed-test",
        status: 200,
        inputTokens: 3,
      });
      const everything = (
        await database.pool.query<{ text: string }>(
          `select concat_ws(' ', (select string_agg(row_to_json(r)::text, ' ') from model_requests r),
                                (select string_agg(content, ' ') from model_blobs)) as text`,
        )
      ).rows[0]!.text;
      expect(everything).toContain("Prefers remote roles");
      expect(everything).not.toContain(MEMORY_KEY);
    } finally {
      stand.close();
    }
  });
});
