import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexClient, RpcError } from "./client";

/** A fake app-server that speaks the JSON-RPC subset the client relies on. */
function fakeServer(onMessage: (socket: WebSocket, message: Record<string, unknown>) => void) {
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
        return;
      }
      onMessage(socket, message);
    });
  });
  const url = new Promise<string>((resolve) =>
    server.on("listening", () =>
      resolve(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  return { server, url };
}

const servers: WebSocketServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("CodexClient", () => {
  it("initializes, then matches responses to requests", async () => {
    const seen: string[] = [];
    const { server, url } = fakeServer((socket, message) => {
      seen.push(String(message.method));
      if (message.method === "thread/start") {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "t1" } } }));
      }
    });
    servers.push(server);
    const client = await CodexClient.connect(await url, async () => ({}));
    const result = await client.request("thread/start", { cwd: "/tmp" });
    expect(result.thread.id).toBe("t1");
    expect(seen).toEqual(["initialized", "thread/start"]);
    client.close();
  });

  it("turns JSON-RPC errors into RpcError", async () => {
    const { server, url } = fakeServer((socket, message) => {
      if (message.id !== undefined) {
        socket.send(
          JSON.stringify({ id: message.id, error: { code: -32600, message: "no rollout found" } }),
        );
      }
    });
    servers.push(server);
    const client = await CodexClient.connect(await url, async () => ({}));
    await expect(client.request("thread/resume", { threadId: "missing" })).rejects.toBeInstanceOf(
      RpcError,
    );
    client.close();
  });

  it("answers server requests and emits notifications", async () => {
    const replies: unknown[] = [];
    const { server, url } = fakeServer((socket, message) => {
      if (message.method === "initialized") {
        socket.send(
          JSON.stringify({
            method: "turn/started",
            params: { threadId: "t1", turn: { id: "u1" } },
          }),
        );
        socket.send(
          JSON.stringify({
            id: 99,
            method: "item/tool/call",
            params: { threadId: "t1", tool: "desktop_screenshot", arguments: {} },
          }),
        );
      } else if (message.id === 99) {
        replies.push(message.result);
      }
    });
    servers.push(server);
    const notifications: string[] = [];
    const client = await CodexClient.connect(await url, async (request) => {
      expect(request.method).toBe("item/tool/call");
      return { success: true, contentItems: [{ type: "inputText", text: "ok" }] };
    });
    client.on("notification", (notification) => notifications.push(notification.method));
    await expect.poll(() => replies.length).toBe(1);
    expect(replies[0]).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
    expect(notifications).toContain("turn/started");
    client.close();
  });

  it("shows the observer every message both ways, in wire order, with each response's method", async () => {
    const { server, url } = fakeServer((socket, message) => {
      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            method: "turn/started",
            params: { threadId: "t1", turn: { id: "u1" } },
          }),
        );
        socket.send(
          JSON.stringify({
            id: 7,
            method: "item/tool/call",
            params: { threadId: "t1", turnId: "u1", callId: "call_1", tool: "x", arguments: {} },
          }),
        );
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "u1" } } }));
      } else if (message.method === "turn/interrupt") {
        socket.send(JSON.stringify({ id: message.id, error: { code: -1, message: "no turn" } }));
      }
    });
    servers.push(server);
    const seen: { direction: string; kind: string; method: string; id: unknown }[] = [];
    const payloads: unknown[] = [];
    const sizes: number[] = [];
    // The tool call is answered only once the test lets it, so the order is fixed.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const client = await CodexClient.connect(
      await url,
      async () => {
        await answered;
        return { success: true, contentItems: [] };
      },
      undefined,
      undefined,
      ({ direction, kind, method, id, payload, size }) => {
        seen.push({ direction, kind, method, id });
        payloads.push(payload);
        sizes.push(size);
      },
    );
    await client.request("turn/start", { threadId: "t1", input: [] });
    await expect(
      client.request("turn/interrupt", { threadId: "t1", turnId: "u1" }),
    ).rejects.toThrow("no turn");
    answer();
    await expect.poll(() => seen.some((m) => m.kind === "response" && m.id === 7)).toBe(true);
    expect(seen).toEqual([
      { direction: "to_codex", kind: "request", method: "initialize", id: 1 },
      { direction: "from_codex", kind: "response", method: "initialize", id: 1 },
      { direction: "to_codex", kind: "notification", method: "initialized", id: null },
      { direction: "to_codex", kind: "request", method: "turn/start", id: 2 },
      { direction: "from_codex", kind: "notification", method: "turn/started", id: null },
      { direction: "from_codex", kind: "request", method: "item/tool/call", id: 7 },
      { direction: "from_codex", kind: "response", method: "turn/start", id: 2 },
      { direction: "to_codex", kind: "request", method: "turn/interrupt", id: 3 },
      { direction: "from_codex", kind: "response", method: "turn/interrupt", id: 3 },
      // The answer to the server request, after the handler resolved.
      { direction: "to_codex", kind: "response", method: "item/tool/call", id: 7 },
    ]);
    expect(payloads[6]).toEqual({ result: { turn: { id: "u1" } } });
    expect(payloads[8]).toEqual({ error: { code: -1, message: "no turn" } });
    expect(payloads[9]).toEqual({ result: { success: true, contentItems: [] } });
    // Each message's size is its JSON text's, both ways.
    expect(sizes[6]).toBe(JSON.stringify({ id: 2, result: { turn: { id: "u1" } } }).length);
    expect(sizes[9]).toBe(
      JSON.stringify({ id: 7, result: { success: true, contentItems: [] } }).length,
    );
    client.close();
  });

  it("keeps working when the observer throws", async () => {
    const { server, url } = fakeServer((socket, message) => {
      if (message.method === "thread/start")
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "t1" } } }));
    });
    servers.push(server);
    const client = await CodexClient.connect(
      await url,
      async () => ({}),
      undefined,
      undefined,
      () => {
        throw new Error("observer failed");
      },
    );
    const started = await client.request("thread/start", {} as never);
    expect(started.thread.id).toBe("t1");
    client.close();
  });

  it("fails pending requests when the connection drops", async () => {
    const { server, url } = fakeServer((socket, message) => {
      if (message.method === "turn/start") socket.terminate();
    });
    servers.push(server);
    const client = await CodexClient.connect(await url, async () => ({}));
    const closed = new Promise((resolve) => client.once("close", resolve));
    await expect(client.request("turn/start", { threadId: "t1", input: [] })).rejects.toThrow(
      /closed/i,
    );
    await closed;
    expect(client.isOpen).toBe(false);
  });
});

it("cancels an unresponsive initialization within the shared wake deadline", async () => {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  const url = await new Promise<string>((resolve) =>
    server.on("listening", () =>
      resolve(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  // Accept the transport but deliberately never answer initialize.
  const controller = new AbortController();
  const connecting = CodexClient.connect(url, async () => ({}), undefined, controller.signal);
  const rejected = expect(connecting).rejects.toThrow();
  setTimeout(() => controller.abort(new Error("wake deadline")), 25);
  await rejected;
  for (const socket of server.clients) socket.terminate();
});
