import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { modelRequests } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Context } from "../../context";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelProxy } from "./proxy";
import { modelProxyToken } from "./routing";
import { ResponsesStandIn, codexBody, turnEvents, user } from "./testing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-proxy-plan-test-key";
const TOKEN = modelProxyToken(ENCRYPTION_KEY);
const CHATGPT_TOKEN = "chatgpt-access-token-from-the-computer";
/** What Codex sends with every plan request, from the computer's ChatGPT login. */
const LOGIN = {
  authorization: `Bearer ${CHATGPT_TOKEN}`,
  "chatgpt-account-id": "account-1",
  cookie: "session=from-the-computer",
};

/** The plan route over HTTP, the transport Codex falls back to, and in a rehearsal. */
describe.skipIf(!url)("model proxy plan route", () => {
  const database = testDatabase(url);
  const { db } = database;
  const chatgpt = new ResponsesStandIn();
  const rehearsal = new ResponsesStandIn();
  let writer: ModelLogWriter;
  let chatgptUrl = "";
  const servers: http.Server[] = [];

  beforeAll(async () => {
    await database.create();
    writer = new ModelLogWriter(db, { warn() {}, error() {} }, { flushMs: 5 });
    chatgptUrl = await chatgpt.listen();
  });

  afterAll(async () => {
    await writer.stop();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    chatgpt.close();
    rehearsal.close();
    await database.drop();
  });

  /** A worker whose plan route goes to `upstream`, ChatGPT's stand-in or a rehearsal's. */
  async function worker(upstream: { chatgptUrl?: string; rehearsalUrl?: string }) {
    const proxy = new ModelProxy({
      env: {
        ENCRYPTION_KEY,
        OPENAI_API_BASE_URL: "http://127.0.0.1:9/v1",
        ...(upstream.rehearsalUrl ? { OPEN_BOT_PLAN_BASE_URL: upstream.rehearsalUrl } : {}),
      },
      runs: { apiKeyRun: () => null, teammateFor: () => null },
      writer,
      log: { warn() {}, error() {} },
      ...(upstream.chatgptUrl ? { chatgptUrl: upstream.chatgptUrl } : {}),
    });
    const ctx = {
      env: { WORKER_SECRET: "model-proxy-plan-worker-secret" },
      log: { info() {}, warn() {}, error() {}, child: () => ctx.log },
    } as unknown as Context;
    const server = createHttpServer({ ctx, modelProxy: proxy } as unknown as HttpDeps);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `127.0.0.1:${(server.address() as AddressInfo).port}/model-proxy/${TOKEN}/plan`;
  }

  function written(): Promise<void> {
    return once(writer, "written").then(() => undefined);
  }

  async function post(target: string, thread: string) {
    const answer = await fetch(`http://${target}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": thread, ...LOGIN },
      body: JSON.stringify(codexBody(thread, "turn-1", [user("hi")])),
    });
    return { status: answer.status, body: await answer.text() };
  }

  it("passes Codex's ChatGPT login through to ChatGPT unchanged, and never stores it", async () => {
    const target = await worker({ chatgptUrl });
    const saved = written();
    const answer = await post(target, "thread-plan-http");
    expect(answer).toEqual({ status: 200, body: turnEvents("pong over HTTP").join("") });
    const [sent] = chatgpt.httpRequests;
    expect(sent!.url).toBe("/backend-api/codex/responses");
    expect(sent!.headers).toMatchObject(LOGIN);
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-plan-http"));
    expect(row).toMatchObject({
      route: "plan",
      transport: "http",
      endpoint: "/responses",
      status: 200,
      costMicros: 0,
      responseText: "pong over HTTP",
    });
    const stored = JSON.stringify(row);
    for (const secret of [CHATGPT_TOKEN, "session=from-the-computer", "account-1"])
      expect(stored).not.toContain(secret);
  });

  it("gives a rehearsal's stand-in none of Codex's credentials, over HTTP or a WebSocket", async () => {
    const rehearsalUrl = (await rehearsal.listen()).replace("/backend-api/codex", "/plan");
    const target = await worker({ rehearsalUrl });
    const saved = written();
    expect((await post(target, "thread-rehearsal")).status).toBe(200);
    await saved;
    const [sent] = rehearsal.httpRequests;
    expect(sent!.url).toBe("/plan/responses");
    expect(sent!.headers.authorization).toBe("Bearer plan-rehearsal");
    expect(sent!.headers).not.toHaveProperty("cookie");
    expect(sent!.headers).not.toHaveProperty("chatgpt-account-id");
    expect(JSON.stringify(sent!.headers)).not.toContain(CHATGPT_TOKEN);

    const upgraded = once(rehearsal, "connection") as Promise<[WebSocket, http.IncomingMessage]>;
    const client = new WebSocket(`ws://${target}/backend-api/codex/responses`, { headers: LOGIN });
    const [[, request]] = (await Promise.all([upgraded, once(client, "open")])) as [
      [WebSocket, http.IncomingMessage],
      unknown,
    ];
    expect(request.headers.authorization).toBe("Bearer plan-rehearsal");
    expect(request.headers).not.toHaveProperty("cookie");
    expect(request.headers).not.toHaveProperty("chatgpt-account-id");
    client.close();
  });

  it("answers 502 when the upstream can't be reached, and logs it", async () => {
    // A port nothing listens on.
    const closed = http.createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    const target = await worker({ chatgptUrl: `http://127.0.0.1:${port}/backend-api/codex` });
    const saved = written();
    const client = new WebSocket(`ws://${target}/backend-api/codex/responses`, {
      headers: { ...LOGIN, "thread-id": "thread-unreachable" },
    });
    const [, response] = (await once(client, "unexpected-response")) as [
      unknown,
      http.IncomingMessage,
    ];
    expect(response.statusCode).toBe(502);
    response.resume();
    await saved;
    const [row] = await db
      .select()
      .from(modelRequests)
      .where(eq(modelRequests.codexThreadId, "thread-unreachable"));
    expect(row).toMatchObject({
      transport: "websocket",
      status: 502,
      errorType: "upstream_unreachable",
    });
  });

  it("refuses paths outside ChatGPT's Codex backend", async () => {
    const target = await worker({ chatgptUrl });
    const before = chatgpt.httpRequests.length;
    for (const path of ["/responses", "/backend-api/codexx/responses", "/backend-api/other"]) {
      const answer = await fetch(`http://${target}${path}`, { method: "POST", body: "{}" });
      expect(answer.status, path).toBe(404);
    }
    expect(chatgpt.httpRequests).toHaveLength(before);
  });
});
