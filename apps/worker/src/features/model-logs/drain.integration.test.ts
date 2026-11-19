import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { modelLogGaps, modelRequests } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../../context";
import { Runtime } from "../../core/runtime";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelProxy } from "./proxy";
import { modelProxyToken } from "./routing";
import { codexBody, turnEvents, user } from "./testing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-proxy-drain-test-key";
const quiet = { warn() {}, error() {} };

describe.skipIf(!url)("model proxy at shutdown", () => {
  const database = testDatabase(url);
  const { db } = database;
  /** Each stand-in response waits for its turn to be released. */
  let release: () => void = () => {};
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const [first, rest] = turnEvents("pong at shutdown");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(first);
      release = () => response.end(rest);
    });
  });

  beforeAll(async () => {
    await database.create();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    upstream.close();
    await database.drop();
  });

  /** A worker's model logging, registered with a Runtime in the order index.ts uses. */
  async function worker(drainMs: number) {
    const runtime = new Runtime(quiet);
    const writer = new ModelLogWriter(db, quiet, { flushMs: 5 });
    await runtime.start("model log writer", writer);
    /** What the proxy told the writer, in order, and what the writer dropped. */
    const calls: string[] = [];
    writer.on("dropped", (requests, reason) => calls.push(`dropped ${requests}: ${reason}`));
    const proxy = new ModelProxy({
      env: {
        ENCRYPTION_KEY,
        OPENAI_API_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      },
      runs: { apiKeyRun: () => ({ apiKey: "sk-drain", teammateId: null as unknown as string }) },
      writer: {
        add: (record) => {
          calls.push("add");
          writer.add(record);
        },
        lost: (startedAt, reason) => {
          calls.push(`lost ${startedAt.length}`);
          writer.lost(startedAt, reason);
        },
      },
      log: quiet,
    });
    runtime.add("model proxy", () => proxy.drain(drainMs));
    const ctx = {
      env: { WORKER_SECRET: "model-proxy-drain-secret" },
      log: { info() {}, warn() {}, error() {}, child: () => ctx.log },
    } as unknown as Context;
    const server = createHttpServer({ ctx, modelProxy: proxy } as unknown as HttpDeps);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    runtime.add("http server", () => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model-proxy/${modelProxyToken(ENCRYPTION_KEY)}/api`;
    return { runtime, base, proxy, calls };
  }

  /** Starts a streamed turn and resolves once its first event has reached the client. */
  async function startTurn(base: string, thread: string) {
    const request = http.request(`${base}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": thread },
    });
    request.end(JSON.stringify(codexBody(thread, "turn-1", [user("hi")])));
    const [response] = (await once(request, "response")) as [http.IncomingMessage];
    await once(response, "data");
    return { ended: once(response.resume(), "end") };
  }

  it("logs a request still streaming when shutdown begins", async () => {
    const { runtime, base, calls } = await worker(10_000);
    const turn = await startTurn(base, "thread-streaming");
    const stopping = runtime.stop();
    // Everything shutdown does without waiting has run before the stand-in's next bytes arrive.
    release();
    await turn.ended;
    await stopping;
    const rows = await db
      .select({ status: modelRequests.status, text: modelRequests.responseText })
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-streaming"));
    expect(rows).toEqual([{ status: 200, text: "pong at shutdown" }]);
    expect(await db.select().from(modelLogGaps)).toEqual([]);
    expect(calls).toEqual(["add"]);
  });

  it("records a request that outlasts the drain as lost, and never logs it late", async () => {
    const { runtime, base, proxy, calls } = await worker(20);
    const turn = await startTurn(base, "thread-outlasting");
    await runtime.stop();
    const gaps = await db.select().from(modelLogGaps);
    expect(gaps).toMatchObject([
      { requests: 1, reason: "the worker shut down before they finished" },
    ]);
    const lost = ["lost 1", "dropped 1: the worker shut down before they finished"];
    expect(calls).toEqual(lost);

    // The response finishes after shutdown: its log is put together, then left out.
    const settled = once(proxy, "settled");
    release();
    await turn.ended;
    await settled;
    expect(calls).toEqual(lost);
  });
});
