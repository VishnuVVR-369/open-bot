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
import WebSocket from "ws";
import {
  ResponsesStandIn,
  codexBody,
  responseEvents,
  assistantItem,
  turnEvents,
  user,
  wsCreate,
} from "./testing";
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

  /** ChatGPT over WebSockets: each response stops after its first events until released. */
  const standIn = new ResponsesStandIn();
  let chatgptUrl = "";
  let releaseSocket: () => void = () => {};
  standIn.respond = ({ socket }) => {
    const events = responseEvents("resp-1", [assistantItem("pong at shutdown")]);
    for (const event of events.slice(0, 3)) socket.send(JSON.stringify(event));
    releaseSocket = () => {
      for (const event of events.slice(3)) socket.send(JSON.stringify(event));
    };
  };

  beforeAll(async () => {
    await database.create();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    chatgptUrl = await standIn.listen();
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    upstream.close();
    standIn.close();
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
      runs: {
        apiKeyRun: () => ({ apiKey: "sk-drain", teammateId: null as unknown as string }),
        teammateFor: () => null,
      },
      chatgptUrl,
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
    const port = (server.address() as AddressInfo).port;
    const plan = `ws://127.0.0.1:${port}/model-proxy/${modelProxyToken(ENCRYPTION_KEY)}/plan/backend-api/codex/responses`;
    return { runtime, base, plan, proxy, calls };
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

  /** Opens a Codex WebSocket and resolves once the upstream has it too. */
  async function connect(plan: string) {
    const upstream = once(standIn, "connection") as Promise<[WebSocket]>;
    const client = new WebSocket(plan, { headers: { "thread-id": "thread-socket" } });
    const [, [socket]] = await Promise.all([once(client, "open"), upstream]);
    const closed = once(client, "close") as Promise<[number, Buffer]>;
    return { client, closed, socket };
  }

  it("lets a WebSocket response finish and logs it, closing each connection once it is idle", async () => {
    const { runtime, plan, calls } = await worker(10_000);
    const idle = await connect(plan);
    const busy = await connect(plan);
    const messages: string[] = [];
    const firstEvents = new Promise<void>((resolve) =>
      busy.client.on("message", (data) => {
        messages.push(String(data));
        if (messages.length === 3) resolve();
      }),
    );
    busy.client.send(JSON.stringify(wsCreate("thread-socket", "turn-1", [user("hi")])));
    await firstEvents;

    const stopping = runtime.stop();
    // The idle connection closes at once, as a server going away.
    expect((await idle.closed)[0]).toBe(1001);
    // The one with a response streaming stays open until the response ends, then closes.
    releaseSocket();
    const [code] = await busy.closed;
    expect(code).toBe(1001);
    expect(JSON.parse(messages.at(-1)!)).toMatchObject({ type: "response.completed" });
    await stopping;
    const rows = await db
      .select({ transport: modelRequests.transport, text: modelRequests.responseText })
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-socket"));
    expect(rows).toEqual([{ transport: "websocket", text: "pong at shutdown" }]);
    expect(calls).toEqual(["add"]);
  });

  it("delivers what is queued for a slow client before closing it at shutdown", async () => {
    const final = JSON.stringify({
      type: "response.completed",
      response: { id: "resp-big", status: "completed", metadata: { pad: "x".repeat(12 << 20) } },
    });
    const respond = standIn.respond;
    standIn.respond = ({ socket }) => {
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp-big" } }));
      socket.send(final);
    };
    try {
      const { runtime, plan, proxy, calls } = await worker(10_000);
      const { client, closed, socket } = await connect(plan);
      const messages: string[] = [];
      // Codex stops reading after the first event, with the large last one still to come.
      const first = new Promise<void>((resolve) =>
        client.on("message", (data) => {
          messages.push(String(data));
          if (messages.length > 1) return;
          client.pause();
          resolve();
        }),
      );
      const logged = once(proxy, "settled");
      client.send(JSON.stringify(wsCreate("thread-slow", "turn-1", [user("hi")])));
      await Promise.all([first, logged]);
      const upstreamClosed = once(socket, "close");
      const stopping = runtime.stop();
      // Shutdown has let the upstream go, the response logged; only now does Codex read on.
      await upstreamClosed;
      client.resume();
      const [code] = await closed;
      await stopping;
      expect(code).toBe(1001);
      expect(messages).toHaveLength(2);
      expect(messages[1] === final).toBe(true);
      expect(calls).toEqual(["add"]);
    } finally {
      standIn.respond = respond;
    }
  });

  it("drops a WebSocket that outlasts the drain, and records its response as lost", async () => {
    const { runtime, plan, calls } = await worker(20);
    const busy = await connect(plan);
    const firstEvent = once(busy.client, "message");
    busy.client.send(JSON.stringify(wsCreate("thread-socket-late", "turn-1", [user("hi")])));
    await firstEvent;
    await runtime.stop();
    expect((await busy.closed)[0]).toBe(1006);
    expect(calls).toEqual(["lost 1", "dropped 1: the worker shut down before they finished"]);
  });
});
