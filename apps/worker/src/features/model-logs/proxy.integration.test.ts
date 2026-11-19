import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import {
  bots, // vocabulary: allow
  createDb,
  createPool,
  modelBlobs,
  modelLogGaps,
  modelRequestItems,
  modelRequests,
} from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../../context";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelProxy } from "./proxy";
import { DatabaseRelay, codexBody, sseEvent, turnEvents, user } from "./testing";
import { modelProxyToken } from "./routing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-proxy-test-key";
const API_KEY = "sk-test-model-proxy-key";
const TOKEN = modelProxyToken(ENCRYPTION_KEY);
/** What reading one response may hold here; the turns these tests stream are far smaller. */
const CAPTURE_LIMIT = 64 * 1024;

const SYSTEM = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Rules" }],
};

describe.skipIf(!url)("model proxy", () => {
  const database = testDatabase(url);
  const { db } = database;
  /** Live runs on the API key, by thread. */
  const live = new Map<string, string>();
  let teammateId = "";
  let upstreamRequests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  /** What the stand-in does with the next `/v1/responses` request. */
  let respond: (response: http.ServerResponse) => void = () => {};

  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequests.push({
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }));
        return;
      }
      respond(response);
    });
  });

  let relay: DatabaseRelay;
  let writerPool: ReturnType<typeof createPool>;
  let writer: ModelLogWriter;
  let worker: http.Server;
  let base = "";

  beforeAll(async () => {
    await database.create();
    const [teammate] = await db
      .insert(bots) // vocabulary: allow
      .values({ name: "Iris", slug: "iris", role: "assistant", color: "violet" })
      .returning();
    teammateId = teammate!.id;
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const relayUrl = new URL(database.url);
    relay = new DatabaseRelay({ host: relayUrl.hostname, port: Number(relayUrl.port) });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    relayUrl.host = `127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
    writerPool = createPool(relayUrl.toString());
    writerPool.on("error", () => {});
    writer = new ModelLogWriter(
      createDb(writerPool),
      { warn() {}, error() {} },
      { flushMs: 5, retryForMs: 50, backoffMs: 5, maxBackoffMs: 20 },
    );
    const proxy = new ModelProxy({
      env: {
        ENCRYPTION_KEY,
        OPENAI_API_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      },
      runs: {
        apiKeyRun: (threads) => {
          const thread = threads.find((id) => live.has(id));
          return thread ? { apiKey: live.get(thread)!, teammateId } : null;
        },
        teammateFor: (threads) => (threads.some((id) => live.has(id)) ? teammateId : null),
      },
      writer,
      log: { warn() {}, error() {} },
      captureLimit: CAPTURE_LIMIT,
    });
    const ctx = {
      env: { WORKER_SECRET: "model-proxy-worker-secret" },
      log: { info() {}, warn() {}, error() {}, child: () => ctx.log },
    } as unknown as Context;
    worker = createHttpServer({ ctx, modelProxy: proxy } as unknown as HttpDeps);
    worker.listen(0, "127.0.0.1");
    await once(worker, "listening");
    base = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/model-proxy/${TOKEN}/api`;
  });

  afterAll(async () => {
    await writer?.stop();
    await writerPool?.end();
    for (const server of [worker, upstream, relay?.server]) server?.close();
    await database.drop();
  });

  beforeEach(() => {
    upstreamRequests = [];
    live.clear();
    relay.up();
  });

  /** A POST through the proxy, as Codex sends it; resolves with what the client received. */
  function post(
    path: string,
    body: unknown,
    headers: Record<string, string>,
    onFirstChunk?: () => void,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const request = http.request(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          if (!chunks.length) onFirstChunk?.();
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
  }

  /** Waits for the writer to save `count` more requests. */
  function written(count = 1): Promise<void> {
    return new Promise((resolve) => {
      let seen = 0;
      const on = (requests: number) => {
        seen += requests;
        if (seen < count) return;
        writer.off("written", on);
        resolve();
      };
      writer.on("written", on);
    });
  }

  /** Streams a turn, holding the rest until the client has the first event. */
  function streamTurn(text: string, extraHeaders: Record<string, string> = {}) {
    const [first, rest] = turnEvents(text);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    respond = (response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-ratelimit-remaining-requests": "99",
        ...extraHeaders,
      });
      response.write(first);
      void released.then(() => response.end(rest));
    };
    return { sent: first + rest, release };
  }

  it("streams a response through unchanged, adds the key for a live run, and logs it", async () => {
    live.set("thread-a", API_KEY);
    const turn = streamTurn("pong from the API key");
    const saved = written();
    // The stand-in sends the rest only once the client has the first event: a proxy that held the
    // response back would never finish.
    const answer = await post(
      "/responses",
      codexBody("thread-a", "turn-1", [SYSTEM, user("Say pong.")]),
      { "thread-id": "thread-a", authorization: "Bearer from-the-computer" },
      turn.release,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.toString("utf8")).toBe(turn.sent);
    expect(answer.headers["x-ratelimit-remaining-requests"]).toBe("99");
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe("/v1/responses");
    expect(upstreamRequests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(upstreamRequests[0]!.body)).toEqual(
      codexBody("thread-a", "turn-1", [SYSTEM, user("Say pong.")]),
    );

    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-a"));
    expect(row).toMatchObject({
      source: "codex",
      route: "api",
      transport: "http",
      method: "POST",
      endpoint: "/responses",
      codexTurnId: "turn-1",
      requestKind: "turn",
      teammateId,
      model: "gpt-6.1-sol",
      responseId: "resp_1",
      status: 200,
      inputTokens: 12_000,
      cachedInputTokens: 2_000,
      outputTokens: 300,
      costMicros: 23_200,
      stopReason: "completed",
      responseText: "pong from the API key",
      rateLimitHeaders: { "x-ratelimit-remaining-requests": "99" },
      parseWarnings: [],
    });
    expect(row!.firstByteAt).not.toBeNull();
    expect(row!.params).toMatchObject({ stream: true, tool_choice: "auto" });
    // The key never reaches the log, whatever header carried it.
    const logged = JSON.stringify(
      await db.select().from(modelRequests).where(eq(modelRequests.id, row!.id)),
    );
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain("from-the-computer");
  });

  it("stores each item once, and rebuilds every request from its parts", async () => {
    live.set("thread-b", API_KEY);
    const first = [SYSTEM, user("First question")];
    const second = [...first, user("Second question")];
    for (const [turn, input] of [
      ["turn-1", first],
      ["turn-2", second],
    ] as const) {
      const stream = streamTurn(`answer to ${turn}`);
      stream.release();
      const saved = written();
      await post("/responses", codexBody("thread-b", turn, input), { "thread-id": "thread-b" });
      await saved;
    }
    const rows = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-b"))
      .orderBy(asc(modelRequests.startedAt));
    expect(rows.map((row) => row.codexTurnId)).toEqual(["turn-1", "turn-2"]);
    // The second request repeats the first two items, the instructions and the tools: one copy each.
    const blobs = await db.select().from(modelBlobs);
    const counts = new Map<string, number>();
    for (const blob of blobs) counts.set(blob.content, (counts.get(blob.content) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    for (const value of [SYSTEM, ...second, "You are Codex."])
      expect(counts.get(JSON.stringify(value))).toBe(1);
    // Rebuilt from the row and its items, the body is what Codex sent.
    const secondRow = rows[1]!;
    const items = await db
      .select({ side: modelRequestItems.side, content: modelBlobs.content })
      .from(modelRequestItems)
      .innerJoin(modelBlobs, eq(modelBlobs.hash, modelRequestItems.blobHash))
      .where(eq(modelRequestItems.requestId, secondRow.id))
      .orderBy(asc(modelRequestItems.side), asc(modelRequestItems.position));
    const blob = async (hash: string | null) =>
      JSON.parse(
        (await db.select().from(modelBlobs).where(eq(modelBlobs.hash, hash!)))[0]!.content,
      ) as unknown;
    const rebuilt = {
      ...secondRow.params,
      instructions: await blob(secondRow.instructionsHash),
      tools: await blob(secondRow.toolsHash),
      input: items.filter((item) => item.side === "input").map((item) => JSON.parse(item.content)),
    };
    expect(rebuilt).toEqual(codexBody("thread-b", "turn-2", second));
    expect(
      items.filter((item) => item.side === "output").map((item) => JSON.parse(item.content)),
    ).toEqual([
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "answer to turn-2" }],
      },
    ]);
  });

  it("passes compressed responses through as they came, and logs them decompressed", async () => {
    live.set("thread-gz", API_KEY);
    const [first, rest] = turnEvents("pong, compressed");
    const compressed = zlib.gzipSync(first + rest);
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      response.end(compressed);
    };
    const saved = written();
    const answer = await post("/responses", codexBody("thread-gz", "turn-1", [user("hi")]), {
      "thread-id": "thread-gz",
      "accept-encoding": "gzip",
    });
    expect(answer.headers["content-encoding"]).toBe("gzip");
    expect(answer.body.equals(compressed)).toBe(true);
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-gz"));
    expect(row).toMatchObject({ responseText: "pong, compressed", parseWarnings: [] });
  });

  it("refuses to add the key for a thread without a live run on it", async () => {
    const saved = written();
    const answer = await post("/responses", codexBody("thread-x", "turn-1", [user("hi")]), {
      "thread-id": "thread-x",
    });
    expect(answer.status).toBe(403);
    expect(upstreamRequests).toHaveLength(0);
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-x"));
    expect(row).toMatchObject({ status: 403, errorType: "refused", teammateId: null });
  });

  it("answers 404 to a wrong token or route, without reaching the upstream", async () => {
    for (const path of [
      `/model-proxy/${"0".repeat(64)}/api/responses`,
      `/model-proxy/${TOKEN.slice(0, 10)}/api/responses`,
      `/model-proxy/${TOKEN}/elsewhere/responses`,
      `/model-proxy/${TOKEN}/plan/responses`,
    ]) {
      live.set("thread-a", API_KEY);
      const answer = await fetch(`${new URL(base).origin}${path}`, {
        method: "POST",
        headers: { "thread-id": "thread-a" },
        body: "{}",
      });
      expect(answer.status, path).toBe(404);
    }
    expect(upstreamRequests).toHaveLength(0);
  });

  it("logs only the metadata of a models list", async () => {
    live.set("thread-m", API_KEY);
    const saved = written();
    const answer = await fetch(`${base}/models?client_version=0.162.1`, {
      headers: { "thread-id": "thread-m" },
    });
    expect(await answer.json()).toEqual({ models: [{ slug: "gpt-6.1-sol" }] });
    expect(upstreamRequests[0]!.url).toBe("/v1/models?client_version=0.162.1");
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.endpoint, "/models"));
    expect(row).toMatchObject({ method: "GET", status: 200, params: null, responseText: null });
    expect(row!.responseBytes).toBeGreaterThan(0);
  });

  it("forwards a response past the capture limit whole, and logs only that it gave up", async () => {
    live.set("thread-big", API_KEY);
    // An event that never ends, 64 times the limit, compressed so it is small on the wire.
    const sent = zlib.gzipSync(
      sseEvent({ type: "response.created", response: { id: "resp_big" } }) +
        `data: ${"x".repeat(64 * CAPTURE_LIMIT)}`,
    );
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      response.end(sent);
    };
    const saved = written();
    const answer = await post("/responses", codexBody("thread-big", "turn-1", [user("hi")]), {
      "thread-id": "thread-big",
    });
    expect(answer.status).toBe(200);
    expect(answer.body.equals(sent)).toBe(true);
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-big"));
    expect(row).toMatchObject({ status: 200, responseId: null, responseBytes: sent.length });
    expect(row!.parseWarnings).toContain("the response was too large to read");
    // Its start is kept as it came, and the log says it is only the start.
    expect(row!.rawResponse).toMatch(/^event: response\.created\n/);
    expect(row!.parseWarnings).toContain(
      `only the first ${Buffer.byteLength(row!.rawResponse!)} bytes of the response were kept`,
    );
    const output = await db
      .select()
      .from(modelRequestItems)
      .where(eq(modelRequestItems.requestId, row!.id));
    expect(output.filter((item) => item.side === "output")).toEqual([]);
  });

  it("keeps a JSON answer it can't rebuild as it came", async () => {
    live.set("thread-search", API_KEY);
    // What Codex's `alpha/search` answers: successful, but not a Responses API response.
    const sent = JSON.stringify({ output: "search result", results: [{ type: "text_result" }] });
    respond = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(sent);
    };
    const saved = written();
    await post(
      "/alpha/search",
      { model: "gpt-6.1-sol", input: [user("find this")] },
      {
        "thread-id": "thread-search",
      },
    );
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.endpoint, "/alpha/search"));
    expect(row).toMatchObject({ status: 200, rawResponse: sent });
    expect(row!.parseWarnings).toContain("the response was JSON, but not a Responses API response");
  });

  it("stores an error's events and envelope without the credentials their headers carry", async () => {
    live.set("thread-leaky", API_KEY);
    const error = {
      type: "error",
      status: 429,
      error: { type: "usage_limit_reached", headers: { "x-session-token": "nested-secret" } },
      headers: { "set-cookie": "session=cookie-secret", "chatgpt-account-id": "account-secret" },
    };
    // A stream that ends on an error, so its events are kept as they came.
    const sent =
      sseEvent({ type: "response.created", response: { id: "resp-leaky" } }) + sseEvent(error);
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sent);
    };
    const headers = { "thread-id": "thread-leaky" };
    let saved = written();
    const streamed = await post(
      "/responses",
      codexBody("thread-leaky", "turn-1", [user("hi")]),
      headers,
    );
    expect(streamed.body.toString("utf8")).toBe(sent);
    await saved;
    // An error answer with no message of its own, so its envelope stands in for one.
    respond = (response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.error, headers: error.headers }));
    };
    saved = written();
    await post("/responses", codexBody("thread-leaky", "turn-2", [user("again")]), headers);
    await saved;
    const found = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-leaky"))
      .orderBy(asc(modelRequests.startedAt));
    expect(found.map((row) => row.errorType)).toEqual([
      "usage_limit_reached",
      "usage_limit_reached",
    ]);
    expect(found[0]!.rawResponse).toContain("resp-leaky");
    expect(JSON.stringify(found)).not.toMatch(/nested-secret|cookie-secret|account-secret/);
  });

  it("finishes requests while the database is down, and records the lost ones as a gap", async () => {
    live.set("thread-down", API_KEY);
    relay.down();
    const dropped = once(writer, "dropped");
    const turn = streamTurn("pong without a database");
    turn.release();
    const answer = await post("/responses", codexBody("thread-down", "turn-1", [user("hi")]), {
      "thread-id": "thread-down",
    });
    // The model request completes whatever the database does.
    expect(answer.status).toBe(200);
    expect(answer.body.toString("utf8")).toBe(turn.sent);
    const [lost] = (await dropped) as [number, string];
    expect(lost).toBe(1);

    const gap = once(writer, "gap");
    relay.up();
    await gap;
    const gaps = await db.select().from(modelLogGaps);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ requests: 1 });
    expect(gaps[0]!.reason).toContain("could not be reached");
    expect(
      await db.select().from(modelRequests).where(eq(modelRequests.codexThreadId, "thread-down")),
    ).toEqual([]);

    // Once it is back, requests are logged again.
    const saved = written();
    const again = streamTurn("pong again");
    again.release();
    await post("/responses", codexBody("thread-down", "turn-2", [user("hi")]), {
      "thread-id": "thread-down",
    });
    await saved;
    const rows = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-down"));
    expect(rows.map((row) => row.codexTurnId)).toEqual(["turn-2"]);
  });

  it("stores the blob text with lz4 compression", async () => {
    const { rows } = await database.pool.query<{ compression: string }>(
      `select attcompression as compression from pg_attribute
       where attrelid = 'model_blobs'::regclass and attname = 'content'`,
    );
    expect(rows[0]!.compression).toBe("l");
  });
});
