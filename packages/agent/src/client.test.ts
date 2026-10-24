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
