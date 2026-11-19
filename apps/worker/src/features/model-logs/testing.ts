// Requests and streams shaped like Codex's and the Responses API's, for the model proxy's tests.
import { EventEmitter, once } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

/** Forwards TCP to Postgres, and can cut it off: the database going away and coming back. */
export class DatabaseRelay {
  private readonly sockets = new Set<net.Socket>();
  private open = true;
  readonly server: net.Server;
  constructor(target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      if (!this.open) return void client.destroy();
      const upstream = net.connect(target);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {});
      }
      client.pipe(upstream).pipe(client);
    });
  }
  down() {
    this.open = false;
    for (const socket of this.sockets) socket.destroy();
  }
  up() {
    this.open = true;
  }
}

export const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** A request body shaped like Codex's, on a thread and turn. */
export function codexBody(thread: string, turn: string, input: unknown[]) {
  return {
    model: "gpt-6.1-sol",
    instructions: "You are Codex.",
    input,
    tools: [{ type: "function", name: "exec_command", parameters: {} }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    prompt_cache_key: thread,
    client_metadata: {
      thread_id: thread,
      turn_id: turn,
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: thread,
        turn_id: turn,
        request_kind: "turn",
      }),
    },
  };
}

export function sseEvent(data: Record<string, unknown>) {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The events a turn streams, split where the stand-in pauses: after the first one. */
export function turnEvents(text: string): [string, string] {
  return [
    sseEvent({ type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol" } }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text }],
      },
    }) +
      sseEvent({
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_tokens: 12_000,
            input_tokens_details: { cached_tokens: 2_000 },
            output_tokens: 300,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }),
  ];
}

/** One `response.create` the stand-in received, and the connection it came on. */
export interface StandInRequest {
  body: Record<string, unknown>;
  socket: WebSocket;
  /** How many `response.create` messages came before it on this connection. */
  index: number;
}

/**
 * A stand-in for ChatGPT's Codex backend over WebSockets, as Codex 0.162.1 speaks to it: the
 * upgrade at `/backend-api/codex/responses` answered with ChatGPT's headers, then one response per
 * `response.create`. Tests replace `respond`, `answer` and `refuse`, and wait on its events.
 */
export class ResponsesStandIn extends EventEmitter<{
  connection: [socket: WebSocket, request: http.IncomingMessage];
  request: [request: StandInRequest];
}> {
  readonly server = http.createServer();
  private readonly sockets = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  /** Answers a `response.create`; by default a completed response with one message. */
  respond: (request: StandInRequest) => void = ({ socket, index }) => {
    for (const event of responseEvents(`resp-${index + 1}`, [assistantItem(`answer ${index + 1}`)]))
      socket.send(JSON.stringify(event));
  };
  /** Answers an HTTP request; by default a streamed turn. */
  answer: (response: http.ServerResponse) => void = (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(turnEvents("pong over HTTP").join(""));
  };
  /** HTTP requests it received, with their headers and body. */
  readonly httpRequests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  /** When set, the upgrade is answered with this instead. */
  refuse: { status: number; headers: Record<string, string>; body: string } | null = null;
  /** When set, writes its own answer to the upgrade, byte by byte as the test decides. */
  refuseRaw: ((socket: Duplex) => void) | null = null;

  constructor() {
    super();
    this.sockets.on("headers", (headers) =>
      headers.push(
        "x-reasoning-included: true",
        "openai-model: gpt-6.1-sol",
        "x-codex-turn-state: ts-1",
      ),
    );
    // Codex's HTTP fallback: a streamed turn.
    this.server.on("request", (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.httpRequests.push({
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        this.answer(response);
      });
    });
    this.server.on("upgrade", (request, socket, head) => {
      if (this.refuseRaw) return this.refuseRaw(socket);
      if (this.refuse) {
        const { status, headers, body } = this.refuse;
        const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
        socket.end(
          `HTTP/1.1 ${status} Refused\r\n${lines.join("\r\n")}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        let index = 0;
        ws.on("message", (data, binary) => {
          if (binary) return;
          let body: unknown;
          try {
            body = JSON.parse(String(data));
          } catch {
            return;
          }
          if ((body as { type?: unknown }).type !== "response.create") return;
          const request = { body: body as Record<string, unknown>, socket: ws, index: index++ };
          this.emit("request", request);
          this.respond(request);
        });
        this.emit("connection", ws, request);
      });
    });
  }

  async listen(): Promise<string> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/backend-api/codex`;
  }

  close() {
    for (const socket of this.sockets.clients) socket.terminate();
    this.server.closeAllConnections();
    this.server.close();
  }
}

export const assistantItem = (text: string, id = "msg_1") => ({
  type: "message",
  role: "assistant",
  id,
  content: [{ type: "output_text", text }],
});

/** The events of one response over a WebSocket, ending in `response.completed`. */
export function responseEvents(id: string, output: unknown[]) {
  return [
    { type: "codex.response.metadata", headers: { "x-models-etag": "etag-1" } },
    {
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: { primary: { used_percent: 42, window_minutes: 300, reset_at: 1_800_000_000 } },
    },
    { type: "response.created", response: { id, model: "gpt-6.1-sol" } },
    ...output.map((item, index) => ({
      type: "response.output_item.done",
      output_index: index,
      item,
    })),
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        usage: {
          input_tokens: 1_000,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens: 20,
        },
      },
    },
  ];
}

/** A `response.create` as Codex sends it over a WebSocket, on a thread and turn. */
export function wsCreate(thread: string, turn: string, input: unknown[], previous?: string) {
  const { instructions: _instructions, ...body } = codexBody(thread, turn, input);
  return {
    type: "response.create",
    ...body,
    ...(previous ? { previous_response_id: previous } : {}),
    input,
  };
}
