import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { modelRequests } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { ERROR_TOO_DEEP } from "@open-bot/domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Context } from "../../context";
import { createHttpServer, type HttpDeps } from "../../http";
import { ModelProxy } from "./proxy";
import { modelProxyToken } from "./routing";
import { RAW_RESPONSE_LIMIT } from "./response-tap";
import {
  ResponsesStandIn,
  assistantItem,
  codexBody,
  responseEvents,
  sseEvent,
  user,
  wsCreate,
} from "./testing";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();
const ENCRYPTION_KEY = "model-proxy-unreadable-test-key";
const TOKEN = modelProxyToken(ENCRYPTION_KEY);
const CHATGPT_TOKEN = "chatgpt-access-token-from-the-computer";
/** Small, so that a long answer is given up on and kept only as it came. */
const CAPTURE_LIMIT = 64 * 1024;
/** Header values that must never be stored, wherever the answer carries them. */
const SECRETS = /cookie-secret|account-secret|nested-secret/;
const LEAKY_HEADERS = {
  "set-cookie": "session=cookie-secret",
  "chatgpt-account-id": "account-secret",
  "x-codex-primary-used-percent": "100",
};
const CUT = "the raw response was cut where a header object in it could not be read";

/** JSON nested `depth` objects deep, written out, since `JSON.stringify` can't go as deep. */
function nested(depth: number): string {
  return '{"m":'.repeat(depth) + "1" + "}".repeat(depth);
}

/** An error event with no message of its own, its envelope nested `depth` objects deep. */
function deepError(depth: number): string {
  return (
    `{"type":"error","status":400,"error":{"type":"invalid_request_error","metadata":${nested(depth)}},` +
    `"headers":{"set-cookie":"session=cookie-secret"}}`
  );
}

/**
 * Answers the proxy can't read whole (cut by the raw limit, pretty-printed, nested past what is
 * walked), over HTTP and WebSocket on the plan route: Codex gets every byte, the worker keeps
 * serving, and the request is logged with a warning and without the credentials in the answer.
 */
describe.skipIf(!url)("model proxy answers it can't read", () => {
  const database = testDatabase(url);
  const { db } = database;
  const standIn = new ResponsesStandIn();
  const errors: string[] = [];
  let writer: ModelLogWriter;
  let worker: http.Server;
  /** The plan route's address, without a scheme. */
  let base = "";

  beforeAll(async () => {
    await database.create();
    writer = new ModelLogWriter(db, { warn() {}, error() {} }, { flushMs: 5 });
    const chatgptUrl = await standIn.listen();
    const log = { warn() {}, error: (message: string) => void errors.push(message) };
    const proxy = new ModelProxy({
      env: { ENCRYPTION_KEY, OPENAI_API_BASE_URL: "http://127.0.0.1:9/v1" },
      runs: { apiKeyRun: () => null, teammateFor: () => null },
      writer,
      log,
      captureLimit: CAPTURE_LIMIT,
      chatgptUrl,
    });
    const ctx = {
      env: { WORKER_SECRET: "model-proxy-unreadable-worker-secret" },
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

  const answerTurn = standIn.answer;
  const respondTurn = standIn.respond;
  beforeEach(() => {
    errors.length = 0;
    standIn.answer = answerTurn;
    standIn.respond = respondTurn;
  });

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

  /** Posts a body (as text, so it can nest past what `JSON.stringify` writes) as Codex does. */
  function post(thread: string, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request(`http://${base}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CHATGPT_TOKEN}`,
          "content-type": "application/json",
          "thread-id": thread,
        },
      });
      request.on("error", reject);
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      request.end(body);
    });
  }

  const turnBody = (thread: string) => JSON.stringify(codexBody(thread, "turn-1", [user("hi")]));

  /** Answers the next HTTP request with `body`, as `contentType`. */
  function answerWith(contentType: string, body: string) {
    standIn.answer = (response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    };
  }

  async function connect() {
    const upstream = once(standIn, "connection");
    const client = new WebSocket(`ws://${base}/responses`, {
      headers: { authorization: `Bearer ${CHATGPT_TOKEN}` },
    });
    await Promise.all([once(client, "open"), upstream]);
    return client;
  }

  /** Sends a message and resolves with what Codex receives until `done` says that's all. */
  function send(
    client: WebSocket,
    message: string,
    done: (messages: string[]) => boolean,
  ): Promise<string[]> {
    const received: string[] = [];
    const all = new Promise<string[]>((resolve) => {
      const on = (data: WebSocket.RawData) => {
        received.push(String(data));
        if (!done(received)) return;
        client.off("message", on);
        resolve(received);
      };
      client.on("message", on);
    });
    client.send(message);
    return all;
  }

  const completed = (messages: string[]) => messages.at(-1)!.includes('"response.completed"');

  describe("over HTTP", () => {
    it("drops a pretty-printed body cut by the raw limit from its first headers key on", async () => {
      const body = JSON.stringify(
        { headers: LEAKY_HEADERS, padding: "p".repeat(RAW_RESPONSE_LIMIT + 1024) },
        null,
        2,
      );
      answerWith("application/json", body);
      const saved = written();
      expect(await post("http-pretty-cut", turnBody("http-pretty-cut"))).toEqual({
        status: 200,
        body,
      });
      await saved;
      const [row] = await rows("http-pretty-cut");
      expect(row!.rawResponse).toBe(body.slice(0, body.indexOf('"headers"')));
      expect(row!.parseWarnings).toContain(CUT);
      expect(JSON.stringify(row)).not.toMatch(SECRETS);
    });

    it("redacts an event stream event by event, a pretty-printed event's data lines as one", async () => {
      const error = { type: "error", error: { type: "server_error" }, headers: LEAKY_HEADERS };
      const data = JSON.stringify(error, null, 2)
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n");
      // Not completed, so the events are kept as they came.
      const body =
        sseEvent({ type: "response.created", response: { id: "resp-pretty" } }) +
        `event: error\n${data}\n\n`;
      answerWith("text/event-stream", body);
      const saved = written();
      expect((await post("http-pretty-sse", turnBody("http-pretty-sse"))).body).toBe(body);
      await saved;
      const [row] = await rows("http-pretty-sse");
      expect(row!.rawResponse).toContain("resp-pretty");
      expect(row!.rawResponse).toContain("x-codex-primary-used-percent");
      expect(row!.parseWarnings).not.toContain(CUT);
      expect(JSON.stringify(row)).not.toMatch(SECRETS);
    });

    it("forwards and logs an error event nested too deep to redact, and keeps serving", async () => {
      // 3,000 nested objects overflowed the stack and took the worker down.
      const body =
        sseEvent({ type: "response.created", response: { id: "resp-deep" } }) +
        `event: error\ndata: ${deepError(3000)}\n\n`;
      answerWith("text/event-stream", body);
      const saved = written();
      expect(await post("http-deep", turnBody("http-deep"))).toEqual({ status: 200, body });
      await saved;
      const [row] = await rows("http-deep");
      expect(row).toMatchObject({
        status: 200,
        errorType: "invalid_request_error",
        errorMessage: ERROR_TOO_DEEP,
      });
      expect(row!.parseWarnings).toEqual(expect.arrayContaining([ERROR_TOO_DEEP, CUT]));
      expect(JSON.stringify(row)).not.toMatch(SECRETS);

      standIn.answer = answerTurn;
      const next = written();
      expect((await post("http-deep-next", turnBody("http-deep-next"))).status).toBe(200);
      await next;
      expect(await rows("http-deep-next")).toMatchObject([{ responseText: "pong over HTTP" }]);
    });

    it("logs a request whose body nests too deep to store, with a warning", async () => {
      const deepInput = `{"model":"gpt-6.1-sol","input":[${nested(500_000)}],"stream":true}`;
      const deepParams =
        turnBody("http-deep-params").slice(0, -1) + `,"metadata":${nested(500_000)}}`;
      const saved = written(2);
      expect((await post("http-deep-input", deepInput)).status).toBe(200);
      expect((await post("http-deep-params", deepParams)).status).toBe(200);
      await saved;
      const [input] = await rows("http-deep-input");
      expect(input).toMatchObject({ status: 200, responseText: null, params: null });
      expect(input!.parseWarnings.join("\n")).toContain("the request could not be logged in full");
      const [params] = await rows("http-deep-params");
      expect(params).toMatchObject({ params: null, responseText: "pong over HTTP" });
      expect(params!.parseWarnings).toContain(
        "the request's parameters were nested too deeply to keep",
      );
    });
  });

  describe("over a WebSocket", () => {
    it("drops a pretty-printed message cut by the raw limit from its first headers key on", async () => {
      const metadata = JSON.stringify(
        {
          type: "codex.response.metadata",
          headers: LEAKY_HEADERS,
          padding: "p".repeat(RAW_RESPONSE_LIMIT + 1024),
        },
        null,
        2,
      );
      const failed = JSON.stringify({
        type: "error",
        status: 429,
        error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
      });
      standIn.respond = ({ socket }) => {
        socket.send(metadata);
        socket.send(failed);
      };
      const client = await connect();
      const saved = written();
      const received = await send(
        client,
        JSON.stringify(wsCreate("ws-pretty-cut", "turn-1", [user("hi")])),
        (messages) => messages.length === 2,
      );
      expect(received).toEqual([metadata, failed]);
      await saved;
      client.close();
      const [row] = await rows("ws-pretty-cut");
      expect(row).toMatchObject({ status: 429, errorType: "usage_limit_reached" });
      expect(row!.rawResponse).toBe(metadata.slice(0, metadata.indexOf('"headers"')));
      expect(row!.parseWarnings).toContain(CUT);
      expect(JSON.stringify(row)).not.toMatch(SECRETS);
    });

    it("redacts a short, whole response whose one pretty-printed event spans lines", async () => {
      const created = JSON.stringify({ type: "response.created", response: { id: "resp-short" } });
      const error = JSON.stringify(
        {
          type: "error",
          status: 429,
          error: { type: "usage_limit_reached", headers: { "x-session-token": "nested-secret" } },
          headers: LEAKY_HEADERS,
        },
        null,
        1,
      );
      standIn.respond = ({ socket }) => {
        socket.send(created);
        socket.send(error);
      };
      const client = await connect();
      const saved = written();
      await send(
        client,
        JSON.stringify(wsCreate("ws-pretty-short", "turn-1", [user("hi")])),
        (messages) => messages.length === 2,
      );
      await saved;
      client.close();
      const [row] = await rows("ws-pretty-short");
      expect(row).toMatchObject({ status: 429, errorType: "usage_limit_reached" });
      expect(row!.rawResponse!.split("\n")[0]).toBe(created);
      expect(row!.rawResponse).toContain("x-codex-primary-used-percent");
      expect(row!.parseWarnings).not.toContain(CUT);
      expect(JSON.stringify(row)).not.toMatch(SECRETS);
    });

    it("ends and logs a response on an error nested too deep to redact, and keeps the connection", async () => {
      const deep = deepError(3000);
      standIn.respond = ({ socket, index }) => {
        if (index === 0) return socket.send(deep);
        for (const event of responseEvents("resp-after", [assistantItem("still here")]))
          socket.send(JSON.stringify(event));
      };
      const client = await connect();
      let saved = written();
      const received = await send(
        client,
        JSON.stringify(wsCreate("ws-deep", "turn-1", [user("hi")])),
        () => true,
      );
      expect(received).toEqual([deep]);
      await saved;
      saved = written();
      await send(client, JSON.stringify(wsCreate("ws-deep", "turn-2", [user("again")])), completed);
      await saved;
      client.close();
      const [failed, next] = await rows("ws-deep");
      expect(failed).toMatchObject({
        status: 400,
        errorType: "invalid_request_error",
        errorMessage: ERROR_TOO_DEEP,
      });
      expect(failed!.parseWarnings).toEqual(expect.arrayContaining([ERROR_TOO_DEEP, CUT]));
      expect(JSON.stringify(failed)).not.toMatch(SECRETS);
      expect(next).toMatchObject({ responseId: "resp-after", responseText: "still here" });
      expect(errors).toEqual([]);
    });

    it("logs a request whose input nests too deep to store, with a warning", async () => {
      const create = JSON.stringify(wsCreate("ws-deep-input", "turn-1", [user("hi")]));
      const message = create.replace('"input":[', `"input":[${nested(500_000)},`);
      const client = await connect();
      const saved = written();
      await send(client, message, completed);
      await saved;
      client.close();
      const [row] = await rows("ws-deep-input");
      expect(row).toMatchObject({ status: 200, codexTurnId: "turn-1", responseText: null });
      expect(row!.parseWarnings.join("\n")).toContain("the request could not be logged in full");
    });
  });
});
