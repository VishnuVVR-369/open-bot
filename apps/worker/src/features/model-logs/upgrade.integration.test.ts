import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { modelRequests } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Context } from "../../context";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelProxy } from "./proxy";
import { modelProxyToken } from "./routing";
import { ResponsesStandIn } from "./testing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-proxy-upgrade-test-key";
const TOKEN = modelProxyToken(ENCRYPTION_KEY);
/** What Codex sends from the computer's ChatGPT login: passed through, never stored. */
const CHATGPT_TOKEN = "chatgpt-access-token-from-the-computer";

/** Codex's WebSocket handshakes through the proxy: those it refuses, and the upstream's refusals. */
describe.skipIf(!url)("model proxy WebSocket handshakes", () => {
  const database = testDatabase(url);
  const { db } = database;
  const standIn = new ResponsesStandIn();
  let writer: ModelLogWriter;
  let worker: http.Server;
  /** The plan route's address, without a scheme. */
  let base = "";

  beforeAll(async () => {
    await database.create();
    writer = new ModelLogWriter(db, { warn() {}, error() {} }, { flushMs: 5 });
    const chatgptUrl = await standIn.listen();
    const proxy = new ModelProxy({
      env: { ENCRYPTION_KEY, OPENAI_API_BASE_URL: "http://127.0.0.1:9/v1" },
      runs: { apiKeyRun: () => null, teammateFor: () => null },
      writer,
      log: { warn() {}, error() {} },
      chatgptUrl,
    });
    const ctx = {
      env: { WORKER_SECRET: "model-proxy-upgrade-worker-secret" },
      log: { info() {}, warn() {}, error() {}, child: () => ctx.log },
    } as unknown as Context;
    worker = createHttpServer({ ctx, modelProxy: proxy } as unknown as HttpDeps);
    worker.listen(0, "127.0.0.1");
    await once(worker, "listening");
    base = `127.0.0.1:${(worker.address() as AddressInfo).port}/model-proxy/${TOKEN}/plan/backend-api/codex`;
  });

  afterAll(async () => {
    await writer?.stop();
    standIn.close();
    worker?.closeAllConnections();
    worker?.close();
    await database.drop();
  });

  beforeEach(() => {
    standIn.refuse = null;
    standIn.refuseRaw = null;
  });

  function written(): Promise<void> {
    return once(writer, "written").then(() => undefined);
  }

  async function row(thread: string) {
    const [found] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, thread));
    return found;
  }

  /** Counts the connections the upstream gets until `stop()` is called. */
  function upstreamConnections() {
    let reached = 0;
    const count = () => reached++;
    standIn.on("connection", count);
    return {
      stop() {
        standIn.off("connection", count);
        return reached;
      },
    };
  }

  /** Connects as Codex does and resolves with the upstream's refusal, its status and headers in. */
  async function refusedUpgrade(thread: string) {
    const client = new WebSocket(`ws://${base}/responses`, {
      headers: { authorization: `Bearer ${CHATGPT_TOKEN}`, "thread-id": thread },
    });
    const [, response] = (await once(client, "unexpected-response")) as [
      unknown,
      http.IncomingMessage,
    ];
    return response;
  }

  async function bodyOf(response: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  it("answers 400 to a malformed handshake without opening the upstream, and keeps serving", async () => {
    const connections = upstreamConnections();
    for (const headers of [
      // Given as is to the upstream connection, these would throw out of the upgrade handler.
      { "sec-websocket-protocol": "duplicate, duplicate" },
      { "sec-websocket-protocol": "not a token" },
      { "sec-websocket-key": "too-short" },
      { "sec-websocket-version": "12" },
    ]) {
      const request = http.request(`http://${base}/responses`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });
      request.end();
      const [response] = (await once(request, "response")) as [http.IncomingMessage];
      expect(response.statusCode, JSON.stringify(headers)).toBe(400);
      expect(await bodyOf(response)).toContain("bad_request");
    }
    // The worker is still up, and a good handshake still goes through.
    const client = new WebSocket(`ws://${base}/responses`, ["codex"]);
    await Promise.all([once(client, "open"), once(standIn, "connection")]);
    expect(client.protocol).toBe("codex");
    client.close();
    expect(connections.stop()).toBe(1);
  });

  it("gives Codex a refusal's status at once, and its body as the upstream sends it", async () => {
    let finish!: () => void;
    // A chunked 426, the rest of its body held back until Codex has the status.
    standIn.refuseRaw = (socket) => {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\ncontent-type: text/plain\r\n" +
          "transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n",
      );
      finish = () => socket.end("5\r\nworld\r\n0\r\n\r\n");
    };
    const saved = written();
    const response = await refusedUpgrade("thread-stalled");
    expect(response.statusCode).toBe(426);
    const body = bodyOf(response);
    finish();
    expect(await body).toBe("helloworld");
    await saved;
    expect(await row("thread-stalled")).toMatchObject({ status: 426, responseBytes: 10 });
  });

  it("passes on a refusal's whole body however long it is, and logs only its start", async () => {
    const body = "r".repeat(1_052_672);
    standIn.refuse = { status: 429, headers: { "content-type": "text/plain" }, body };
    const saved = written();
    const response = await refusedUpgrade("thread-long-refusal");
    expect(response.statusCode).toBe(429);
    expect(await bodyOf(response)).toBe(body);
    await saved;
    const logged = await row("thread-long-refusal");
    expect(logged).toMatchObject({ status: 429, responseBytes: body.length });
    expect(logged!.parseWarnings).toContain("only the first 1048576 bytes of the answer were kept");
  });

  it("gives Codex the upstream's refusal of the upgrade as it came, and logs it", async () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
    });
    standIn.refuse = {
      status: 429,
      headers: { "content-type": "application/json", "x-codex-primary-used-percent": "100" },
      body,
    };
    const saved = written();
    const response = await refusedUpgrade("thread-refused");
    expect(response.statusCode).toBe(429);
    expect(response.headers["x-codex-primary-used-percent"]).toBe("100");
    expect(await bodyOf(response)).toBe(body);
    await saved;
    const logged = await row("thread-refused");
    expect(logged).toMatchObject({
      transport: "websocket",
      method: "GET",
      status: 429,
      errorType: "usage_limit_reached",
      rateLimitHeaders: { "x-codex-primary-used-percent": "100" },
    });
    expect(JSON.stringify(logged)).not.toContain(CHATGPT_TOKEN);
  });

  it("refuses an upgrade with a wrong token or path, without reaching the upstream", async () => {
    const connections = upstreamConnections();
    for (const path of [
      base.replace(TOKEN, "0".repeat(64)),
      base.replace("/backend-api/codex", "/backend-api/other"),
    ]) {
      const client = new WebSocket(`ws://${path}/responses`);
      const [, response] = (await once(client, "unexpected-response")) as [
        unknown,
        http.IncomingMessage,
      ];
      expect(response.statusCode).toBe(404);
      response.resume();
    }
    expect(connections.stop()).toBe(0);
  });
});
