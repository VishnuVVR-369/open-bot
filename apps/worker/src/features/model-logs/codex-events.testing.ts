// Helpers for the Codex event tap's integration tests: a stand-in for Codex's app-server, model
// exchanges as the proxy captures them, and tool items read back for `linkToolItems`.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { type LinkRequest, linkToolItems, rebuildResponse, toolOutputsOf } from "@open-bot/domain";
import type { Pool } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import { recordExchange } from "./capture";

export type Message = Record<string, unknown> & { id?: number; method?: string; params?: unknown };

/**
 * A stand-in for Codex's app-server: answers `initialize`, and hands every other message to the
 * test, which answers as Codex 0.162.1 would.
 */
export class AppServerStandIn {
  readonly server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  readonly listening = once(this.server, "listening");
  socket: WebSocket | null = null;
  onMessage: (message: Message) => void = () => {};
  /** The responses the worker sent to server requests, by id. */
  readonly answers = new Map<number, unknown>();

  constructor() {
    this.server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Message;
        if (message.method === "initialize")
          return this.send({ id: message.id, result: { userAgent: "stand-in" } });
        if (message.method === undefined && typeof message.id === "number")
          return void this.answers.set(message.id, message.result ?? message.error);
        this.onMessage(message);
      });
    });
  }

  get url() {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  send(message: unknown) {
    this.socket!.send(JSON.stringify(message));
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }
}

/** A captured exchange on a thread: the input sent, the output answered, and its times. */
export function exchange(
  teammateId: string,
  thread: string,
  turn: string,
  input: unknown[],
  output: unknown[],
  times: { startedAt: Date; firstByteAt: Date; endedAt: Date },
) {
  return recordExchange(
    {
      route: "plan",
      transport: "websocket",
      method: "response.create",
      endpoint: "/responses",
      teammateId,
      requestHeaders: {},
      requestBody: null,
      requestJson: {
        model: "gpt-6.1-sol",
        input,
        client_metadata: { thread_id: thread, turn_id: turn },
      },
      requestBytes: 0,
      sent: true,
      status: 200,
      responseHeaders: {},
      response: rebuildResponse(
        JSON.stringify({ id: randomUUID(), object: "response", status: "completed", output }),
        "application/json",
      ),
      rawResponse: null,
      responseBytes: 0,
      ...times,
      failure: null,
      warnings: [],
    },
    randomUUID(),
  );
}

/** A thread's requests and tool items read back as `linkToolItems` takes them. */
export async function linksOf(pool: Pool, thread: string) {
  const requests = await pool.query<{
    id: string;
    started_at: Date;
    first_byte_at: Date | null;
    calls: LinkRequest["calls"] | null;
    input: unknown[] | null;
  }>(
    `select r.id, r.started_at, r.first_byte_at,
            (select json_agg(json_build_object('callId', c.call_id, 'type', c.type,
                      'name', c.name, 'arguments', c.arguments) order by c.position)
               from model_tool_calls c where c.request_id = r.id) as calls,
            (select json_agg(b.content::json order by i.position)
               from model_request_items i join model_blobs b on b.hash = i.blob_hash
              where i.request_id = r.id and i.side = 'input'
                and b.content::json->>'type' in ('function_call_output', 'custom_tool_call_output')
            ) as input
       from model_requests r where r.codex_thread_id = $1`,
    [thread],
  );
  const items = await pool.query<{ item_id: string; type: string; at: Date }>(
    `select item_id, min(payload->'item'->>'type') as type, min(at) as at from codex_events
      where codex_thread_id = $1 and method in ('item/started', 'item/completed')
      group by item_id order by min(at)`,
    [thread],
  );
  return linkToolItems(
    requests.rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      firstByteAt: row.first_byte_at,
      calls: row.calls ?? [],
      outputs: toolOutputsOf(row.input ?? []),
    })),
    items.rows.map((row) => ({ itemId: row.item_id, type: row.type, at: row.at })),
  );
}
