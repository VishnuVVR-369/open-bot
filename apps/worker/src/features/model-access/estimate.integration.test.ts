import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { modelRequests } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { costMicros, USAGE_ESTIMATE } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../../context";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelLogWriter, ModelProxy, modelProxyToken } from "../model-logs";
import { ModelAccess } from "./service";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-access-estimate-test-key";
const quiet = { warn() {}, error() {} };

const sse = (event: object) =>
  `event: ${String((event as { type: string }).type)}\ndata: ${JSON.stringify(event)}\n\n`;
const body = (thread: string) => ({
  model: "gpt-6.1-sol",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(40_000) }] },
  ],
  stream: true,
  client_metadata: { thread_id: thread, turn_id: "turn-1" },
});
/** The least an estimate counts for `body`: its whole input, uncached, at 2 bytes a token. */
const inputCost = (thread: string) =>
  costMicros({
    inputTokens: Math.ceil(
      Buffer.byteLength(JSON.stringify(body(thread))) / USAGE_ESTIMATE.bytesPerToken,
    ),
    cachedInputTokens: 0,
    outputTokens: 0,
  });

// An API key request that may have cost money without the API saying how much never counts as
// free: the cap counts an estimate that errs high, and the fallback stays on (Codex cancels and
// interrupts requests all the time).
describe.skipIf(!url)("API key requests without reported usage", () => {
  const database = testDatabase(url);
  const { db, pool } = database;
  /** What the stand-in does with the next request. */
  let respond: (response: http.ServerResponse) => void = () => {};
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => respond(response));
  });
  let writer: ModelLogWriter;
  let worker: http.Server;
  let base = "";
  const access = () =>
    new ModelAccess(
      {
        db,
        pool,
        env: { ENCRYPTION_KEY, MODEL_PROXY: true },
        log: { info() {}, warn() {}, error() {} },
      } as unknown as Context,
      writer,
    );

  beforeAll(async () => {
    await database.create();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    writer = new ModelLogWriter(db, quiet, { flushMs: 5 });
    const proxy = new ModelProxy({
      env: {
        ENCRYPTION_KEY,
        OPENAI_API_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      },
      runs: {
        apiKeyRun: () => ({ apiKey: "sk-estimate", teammateId: null as unknown as string }),
        teammateFor: () => null,
      },
      writer,
      log: quiet,
    });
    const ctx = {
      env: { WORKER_SECRET: "model-access-estimate-secret" },
      log: { info() {}, warn() {}, error() {}, child: () => ctx.log },
    } as unknown as Context;
    worker = createHttpServer({ ctx, modelProxy: proxy } as unknown as HttpDeps);
    worker.listen(0, "127.0.0.1");
    await once(worker, "listening");
    base = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/model-proxy/${modelProxyToken(ENCRYPTION_KEY)}/api`;
  });
  afterAll(async () => {
    await writer.stop();
    upstream.closeAllConnections();
    for (const server of [worker, upstream]) server.close();
    await database.drop();
  });

  /** Sends a turn on `thread`; `onResponse` gets the client's side of it. */
  function send(thread: string, onResponse: (response: http.IncomingMessage) => void = () => {}) {
    const request = http.request(`${base}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": thread },
    });
    request.on("error", () => {});
    request.on("response", (response) => {
      response.on("error", () => {});
      onResponse(response);
      response.resume();
    });
    request.end(JSON.stringify(body(thread)));
    return request;
  }

  /** The request logged on `thread`, once the writer saved it. */
  async function logged(thread: string) {
    for (;;) {
      const saved = once(writer, "written");
      const [row] = await db
        .select()
        .from(modelRequests)
        .where(eq(modelRequests.codexThreadId, thread));
      if (row) return row;
      await saved;
    }
  }

  /** The spend a request added, with the fallback still on. */
  async function counts(thread: string, spendBefore: number) {
    const row = await logged(thread);
    expect(row).toMatchObject({ route: "api", usageEstimated: true, countsUsage: true });
    expect(row.costMicros).toBeGreaterThanOrEqual(inputCost(thread));
    expect(row.reasoningTokens).toBeNull();
    expect(row.parseWarnings).toContain(
      "the API reported no usage, so its tokens and cost are an estimate that errs high",
    );
    expect(await access().monthSpendMicros()).toBe(spendBefore + row.costMicros!);
    expect(await access().fallbackOff()).toBeNull();
    return row;
  }

  it("counts an estimate for a stream cut off before its usage", async () => {
    const spend = await access().monthSpendMicros();
    const text = "y".repeat(100_000);
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse({ type: "response.created", response: { id: "resp_cut" } }));
      response.write(sse({ type: "response.output_text.delta", delta: text }));
      // The API's connection drops before `response.completed`.
      setTimeout(() => response.destroy(), 20);
    };
    send("thread-cut");
    const row = await counts("thread-cut", spend);
    // What streamed back counts in full: 100,000 bytes at 2 bytes a token.
    expect(row.outputTokens).toBeGreaterThanOrEqual(50_000);
  });

  it("counts an estimate for a successful answer whose body can't be read", async () => {
    const spend = await access().monthSpendMicros();
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("this is not a stream of events");
    };
    send("thread-unreadable");
    await counts("thread-unreadable", spend);
  });

  it("counts an estimate for a request Codex cancelled", async () => {
    const spend = await access().monthSpendMicros();
    let upstreamClosed!: Promise<unknown>;
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse({ type: "response.created", response: { id: "resp_cancel" } }));
      upstreamClosed = once(response, "close");
    };
    const request = send("thread-cancel", (response) => {
      response.once("data", () => request.destroy());
    });
    await counts("thread-cancel", spend);
    // The proxy let the API's side go too.
    await upstreamClosed;
  });
});
