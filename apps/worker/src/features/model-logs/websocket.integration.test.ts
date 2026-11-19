import { once } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
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
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Context } from "../../context";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelProxy } from "./proxy";
import { modelProxyToken } from "./routing";
import {
  DatabaseRelay,
  ResponsesStandIn,
  assistantItem,
  responseEvents,
  user,
  wsCreate,
} from "./testing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-proxy-websocket-test-key";
const TOKEN = modelProxyToken(ENCRYPTION_KEY);
/** What reading one response may hold here; the turns these tests stream are far smaller. */
const CAPTURE_LIMIT = 64 * 1024;
/** What Codex sends from the computer's ChatGPT login: passed through, never stored. */
const CHATGPT_TOKEN = "chatgpt-access-token-from-the-computer";

const SYSTEM = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Rules" }],
};
const CALL = {
  type: "function_call",
  call_id: "call_1",
  name: "exec_command",
  arguments: '{"cmd":"ls"}',
};
const CALL_OUTPUT = { type: "function_call_output", call_id: "call_1", output: "a.txt" };

describe.skipIf(!url)("model proxy over WebSockets", () => {
  const database = testDatabase(url);
  const { db } = database;
  const standIn = new ResponsesStandIn();
  /** Threads with a live run, on either access mode. */
  const live = new Set<string>();
  let teammateId = "";
  let relay: DatabaseRelay;
  let writerPool: ReturnType<typeof createPool>;
  let writer: ModelLogWriter;
  let worker: http.Server;
  let base = "";
  let standInHost = "";

  beforeAll(async () => {
    await database.create();
    const [teammate] = await db
      .insert(bots) // vocabulary: allow
      .values({ name: "Wren", slug: "wren", role: "assistant", color: "violet" })
      .returning();
    teammateId = teammate!.id;
    const chatgptUrl = await standIn.listen();
    standInHost = new URL(chatgptUrl).host;
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
      { flushMs: 5, retryForMs: 50, backoffMs: 5, maxBackoffMs: 20 },
    );
    const proxy = new ModelProxy({
      env: { ENCRYPTION_KEY, OPENAI_API_BASE_URL: "http://127.0.0.1:9/v1" },
      runs: {
        apiKeyRun: () => null,
        teammateFor: (threads) => (threads.some((id) => live.has(id)) ? teammateId : null),
      },
      writer,
      log: { warn() {}, error() {} },
      captureLimit: CAPTURE_LIMIT,
      chatgptUrl,
    });
    const ctx = {
      env: { WORKER_SECRET: "model-proxy-websocket-worker-secret" },
      log: { info() {}, warn() {}, error() {}, child: () => ctx.log },
    } as unknown as Context;
    worker = createHttpServer({ ctx, modelProxy: proxy } as unknown as HttpDeps);
    worker.listen(0, "127.0.0.1");
    await once(worker, "listening");
    base = `ws://127.0.0.1:${(worker.address() as AddressInfo).port}/model-proxy/${TOKEN}/plan/backend-api/codex`;
  });

  afterAll(async () => {
    await writer?.stop();
    await writerPool?.end();
    standIn.close();
    worker?.closeAllConnections();
    for (const server of [worker, relay?.server]) server?.close();
    await database.drop();
  });

  beforeEach(() => {
    live.clear();
    relay.up();
    standIn.refuse = null;
    standIn.respond = ({ socket, index }) => {
      for (const event of responseEvents(`resp-${index + 1}`, [
        assistantItem(`answer ${index + 1}`),
      ]))
        socket.send(JSON.stringify(event));
    };
  });

  /** Connects as Codex does, and resolves once both the client and the stand-in are open. */
  async function connect(thread: string) {
    const upstream = once(standIn, "connection") as Promise<[WebSocket, http.IncomingMessage]>;
    const client = new WebSocket(`${base}/responses`, {
      perMessageDeflate: true,
      headers: {
        authorization: `Bearer ${CHATGPT_TOKEN}`,
        "chatgpt-account-id": "account-1",
        "openai-beta": "responses_websockets=2026-02-06",
        "thread-id": thread,
        // From when the connection opened: each message names its own turn.
        "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn-0" }),
      },
    });
    // `ws` emits both in one go: listened for together, so neither is missed.
    const [[response], , [socket, request]] = (await Promise.all([
      once(client, "upgrade"),
      once(client, "open"),
      upstream,
    ])) as [[http.IncomingMessage], unknown, [WebSocket, http.IncomingMessage]];
    return { client, response, socket, request };
  }

  /** Sends a request and resolves with every message of its response, as the client got them. */
  async function exchange(client: WebSocket, body: unknown): Promise<string[]> {
    const received: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const on = (data: WebSocket.RawData) => {
        received.push(String(data));
        const type = (JSON.parse(String(data)) as { type: string }).type;
        if (type !== "response.completed") return;
        client.off("message", on);
        resolve();
      };
      client.on("message", on);
      client.once("close", () => reject(new Error("closed before the response completed")));
    });
    client.send(JSON.stringify(body));
    await done;
    return received;
  }

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

  async function rows(thread: string) {
    return db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, thread))
      .orderBy(asc(modelRequests.startedAt));
  }

  async function items(requestId: string, side: "input" | "output") {
    const found = await db
      .select({ content: modelBlobs.content })
      .from(modelRequestItems)
      .innerJoin(modelBlobs, eq(modelBlobs.hash, modelRequestItems.blobHash))
      .where(and(eq(modelRequestItems.requestId, requestId), eq(modelRequestItems.side, side)))
      .orderBy(asc(modelRequestItems.position));
    return found.map((item) => JSON.parse(item.content) as unknown);
  }

  it("relays messages, pings and closes both ways unchanged, with each side's headers", async () => {
    const { client, response, socket, request } = await connect("thread-relay");
    // Codex's own login goes through as it came; the upstream's answer reaches Codex.
    expect(request.headers.authorization).toBe(`Bearer ${CHATGPT_TOKEN}`);
    expect(request.headers["chatgpt-account-id"]).toBe("account-1");
    expect(request.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(request.headers.host).toBe(standInHost);
    expect(request.url).toBe("/backend-api/codex/responses");
    expect(response.headers).toMatchObject({
      "x-reasoning-included": "true",
      "openai-model": "gpt-6.1-sol",
      "x-codex-turn-state": "ts-1",
    });

    const text = Buffer.from('{"type":"x","s":"ünïcødé ✓"}');
    const binary = Buffer.from([0, 255, 1, 254, 2, 253]);
    const upstreamGot = once(socket, "message");
    client.send(text, { binary: false });
    const [upData, upBinary] = (await upstreamGot) as [Buffer, boolean];
    expect(upBinary).toBe(false);
    expect(Buffer.compare(upData, text)).toBe(0);
    const clientGot = once(client, "message");
    socket.send(binary);
    const [downData, downBinary] = (await clientGot) as [Buffer, boolean];
    expect(downBinary).toBe(true);
    expect(Buffer.compare(downData, binary)).toBe(0);

    // A ping from the upstream reaches Codex, and Codex's pong goes back.
    const ponged = once(socket, "pong");
    const pinged = once(client, "ping");
    socket.ping(Buffer.from("p1"));
    expect(String(((await pinged) as [Buffer])[0])).toBe("p1");
    expect(String(((await ponged) as [Buffer])[0])).toBe("p1");

    // Codex closes: the upstream sees the same code and reason.
    const upstreamClosed = once(socket, "close");
    client.close(4001, "bye");
    const [code, reason] = (await upstreamClosed) as [number, Buffer];
    expect([code, String(reason)]).toEqual([4001, "bye"]);

    // The upstream closes: Codex sees the same.
    const second = await connect("thread-relay");
    const clientClosed = once(second.client, "close");
    second.socket.close(4002, "done");
    const [code2, reason2] = (await clientClosed) as [number, Buffer];
    expect([code2, String(reason2)]).toEqual([4002, "done"]);
  });

  it("logs each response.create with its full input, rebuilt when Codex sent only new items", async () => {
    live.add("thread-ws");
    standIn.respond = ({ socket, index }) => {
      const output = [
        [CALL],
        [assistantItem("a.txt is there")],
        [assistantItem("hi again", "msg_2")],
      ][index]!;
      for (const event of responseEvents(`resp-${index + 1}`, output))
        socket.send(JSON.stringify(event));
    };
    const { client } = await connect("thread-ws");
    const saved = written(3);
    // A turn: the model calls a tool, Codex sends back only its output; then the next turn.
    const sent = [
      wsCreate("thread-ws", "turn-1", [SYSTEM, user("List the files.")]),
      wsCreate("thread-ws", "turn-1", [CALL_OUTPUT], "resp-1"),
      wsCreate("thread-ws", "turn-2", [user("Thanks!")], "resp-2"),
    ];
    const received: string[][] = [];
    for (const body of sent) received.push(await exchange(client, body));
    expect(received[0]!.map((message) => JSON.parse(message) as unknown)).toEqual(
      responseEvents("resp-1", [CALL]),
    );
    await saved;
    client.close();

    const found = await rows("thread-ws");
    expect(found.map((row) => [row.codexTurnId, row.sentInputFrom, row.responseId])).toEqual([
      ["turn-1", null, "resp-1"],
      ["turn-1", 3, "resp-2"],
      ["turn-2", 5, "resp-3"],
    ]);
    expect(found[0]).toMatchObject({
      source: "codex",
      route: "plan",
      transport: "websocket",
      method: "response.create",
      endpoint: "/responses",
      requestKind: "turn",
      teammateId,
      status: 200,
      costMicros: 0,
      stopReason: "completed",
      inputTokens: 1_000,
      cachedInputTokens: 800,
      parseWarnings: [],
    });
    expect(found[0]!.rateLimitHeaders).toMatchObject({
      "x-codex-primary-used-percent": "42",
      "x-codex-plan-type": "plus",
    });
    expect(found[0]!.responseHeaders).toMatchObject({
      "x-models-etag": "etag-1",
      "openai-model": "gpt-6.1-sol",
    });
    // The handshake's turn is stale for later messages, so it isn't stored with them, and neither
    // are the handshake's own headers.
    expect(found[0]!.requestHeaders).toMatchObject({ "thread-id": "thread-ws" });
    for (const name of ["x-codex-turn-metadata", "sec-websocket-key", "upgrade", "connection"])
      expect(found[0]!.requestHeaders).not.toHaveProperty(name);
    expect(found[2]!.responseText).toBe("hi again");

    const full = [
      SYSTEM,
      user("List the files."),
      CALL,
      CALL_OUTPUT,
      assistantItem("a.txt is there"),
      user("Thanks!"),
    ];
    expect(await items(found[1]!.id, "input")).toEqual(full.slice(0, 4));
    expect(await items(found[2]!.id, "input")).toEqual(full);
    expect(await items(found[0]!.id, "output")).toEqual([CALL]);
    // Each message rebuilds exactly as sent: its parameters, and the input from `sent_input_from` on.
    for (const [index, row] of found.entries()) {
      const input = await items(row.id, "input");
      const tools = (
        await db.select().from(modelBlobs).where(eq(modelBlobs.hash, row.toolsHash!))
      )[0]!;
      expect({
        ...row.params,
        tools: JSON.parse(tools.content) as unknown,
        input: input.slice(row.sentInputFrom ?? 0),
      }).toEqual(sent[index]);
    }
    // The shared history is stored once.
    const blobs = await db.select().from(modelBlobs);
    expect(blobs.filter((blob) => blob.content === JSON.stringify(SYSTEM))).toHaveLength(1);
    // Codex's login and account are never stored.
    expect(JSON.stringify(found)).not.toContain(CHATGPT_TOKEN);
    expect(JSON.stringify(found)).not.toContain("account-1");
  });

  it("drops Codex's connection when the upstream's drops, and logs the response cut short", async () => {
    standIn.respond = ({ socket }) => {
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp-cut" } }), () =>
        socket.terminate(),
      );
    };
    const { client } = await connect("thread-dropped");
    const saved = written();
    const closed = once(client, "close");
    client.send(JSON.stringify(wsCreate("thread-dropped", "turn-1", [user("hi")])));
    const [code] = (await closed) as [number];
    expect(code).toBe(1006);
    await saved;
    const [row] = await rows("thread-dropped");
    expect(row).toMatchObject({
      status: 200,
      responseId: "resp-cut",
      errorType: "upstream_aborted",
    });
    expect(row!.parseWarnings).toContain("the stream ended before the response did");
    expect(row!.rawResponse).toContain("resp-cut");
  });

  it("relays every message while the database is down, and records the lost ones as a gap", async () => {
    relay.down();
    const dropped = once(writer, "dropped");
    const { client } = await connect("thread-down");
    const received = await exchange(client, wsCreate("thread-down", "turn-1", [user("hi")]));
    expect(received.map((message) => JSON.parse(message) as unknown)).toEqual(
      responseEvents("resp-1", [assistantItem("answer 1")]),
    );
    const [lost] = (await dropped) as [number, string];
    expect(lost).toBe(1);
    const gap = once(writer, "gap");
    relay.up();
    await gap;
    client.close();
    const gaps = await db.select().from(modelLogGaps);
    expect(gaps.at(-1)).toMatchObject({ requests: 1 });
    expect(await rows("thread-down")).toEqual([]);
  });

  it("forwards a response past the capture limit whole, and can't rebuild the next from it", async () => {
    const big = "x".repeat(2 * CAPTURE_LIMIT);
    standIn.respond = ({ socket, index }) => {
      for (const event of responseEvents(`resp-${index + 1}`, [assistantItem(index ? "ok" : big)]))
        socket.send(JSON.stringify(event));
    };
    const { client } = await connect("thread-big");
    const saved = written(2);
    const first = await exchange(client, wsCreate("thread-big", "turn-1", [user("hi")]));
    expect(first.some((message) => message.includes(big))).toBe(true);
    await exchange(client, wsCreate("thread-big", "turn-1", [user("more")], "resp-1"));
    await saved;
    client.close();
    const [large, next] = await rows("thread-big");
    expect(large!.parseWarnings).toContain("the response was too large to read");
    expect(await items(large!.id, "output")).toEqual([]);
    expect(next!.sentInputFrom).toBeNull();
    expect(next!.parseWarnings[0]).toContain("resp-1");
    expect(await items(next!.id, "input")).toEqual([user("more")]);
  });

  /** Every message Codex receives until `done` says it has them all. */
  function receive(client: WebSocket, done: (messages: string[]) => boolean): Promise<string[]> {
    const received: string[] = [];
    return new Promise((resolve) => {
      const on = (data: WebSocket.RawData) => {
        received.push(String(data));
        if (!done(received)) return;
        client.off("message", on);
        resolve(received);
      };
      client.on("message", on);
    });
  }

  const completions = (messages: string[]) =>
    messages.filter((message) => message.includes('"response.completed"')).length;

  it("relays a wrapped error as it came, and stores it without the credentials its headers carry", async () => {
    // A terminal error with no message of its own, so its envelope and its raw event are stored.
    const sent = JSON.stringify({
      type: "error",
      status: 429,
      error: { type: "usage_limit_reached", headers: { "x-session-token": "nested-secret" } },
      headers: {
        "set-cookie": "session=cookie-secret",
        "chatgpt-account-id": "account-secret",
        "x-codex-primary-used-percent": "100",
      },
    });
    standIn.respond = ({ socket }) => socket.send(sent);
    const { client } = await connect("thread-wrapped");
    const saved = written();
    const received = receive(client, () => true);
    client.send(JSON.stringify(wsCreate("thread-wrapped", "turn-1", [user("hi")])));
    expect(await received).toEqual([sent]);
    await saved;
    client.close();
    const [row] = await rows("thread-wrapped");
    expect(row).toMatchObject({
      status: 429,
      errorType: "usage_limit_reached",
      rateLimitHeaders: { "x-codex-primary-used-percent": "100" },
    });
    expect(row!.rawResponse).toContain("x-codex-primary-used-percent");
    expect(JSON.stringify(row)).not.toMatch(/nested-secret|cookie-secret|account-secret/);
  });

  it("reads overlapping requests' events in order, says so, and continues from neither", async () => {
    let finishFirst = () => {};
    standIn.respond = ({ socket, index }) => {
      const send = (events: unknown[]) =>
        events.forEach((event) => socket.send(JSON.stringify(event)));
      const events = (id: string, text: string) => responseEvents(id, [assistantItem(text)]);
      if (index === 0) {
        // The first response stops after `response.created` until the second request is sent.
        const first = events("resp-A", "answer A");
        send(first.slice(0, 3));
        finishFirst = () => send(first.slice(3));
      } else if (index === 1) {
        finishFirst();
        send(events("resp-B", "answer B"));
      } else send(events(`resp-${index + 1}`, "answer C"));
    };
    const { client } = await connect("thread-overlap");
    const saved = written(2);
    const started = receive(client, (messages) => messages.length === 3);
    client.send(JSON.stringify(wsCreate("thread-overlap", "turn-A", [user("a")])));
    await started;
    const both = receive(client, (messages) => completions(messages) === 2);
    client.send(JSON.stringify(wsCreate("thread-overlap", "turn-B", [user("b")])));
    await both;
    await saved;
    // Continuing from the second response can't be rebuilt: it may have the first's events.
    const third = written();
    await exchange(client, wsCreate("thread-overlap", "turn-C", [user("c")], "resp-B"));
    await third;
    client.close();
    const [first, second, next] = await rows("thread-overlap");
    for (const [row, turn, id, text] of [
      [first, "turn-A", "resp-A", "answer A"],
      [second, "turn-B", "resp-B", "answer B"],
    ] as const) {
      expect(row).toMatchObject({ codexTurnId: turn, responseId: id, responseText: text });
      expect(row!.parseWarnings.join()).toContain("another request was sent on this connection");
    }
    expect(next!.sentInputFrom).toBeNull();
    expect(next!.parseWarnings[0]).toContain("resp-B");
  });
});
