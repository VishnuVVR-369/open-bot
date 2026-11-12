import { NOTIFY_CHANNELS } from "@open-bot/domain";
import "server-only";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { pool } from "./db";

/**
 * One Postgres LISTEN connection per server process, fanned out to every open SSE stream.
 * Emits `chat` (payload: chat id) and `app` (payload: JSON app event), and `shutdown` when the
 * server is stopping.
 */
class Realtime extends EventEmitter<{ chat: [string]; app: [string]; shutdown: [] }> {
  /**
   * Ends every open stream. Next.js waits for open requests before it exits, and a stream never
   * finishes, so without this a stopped server keeps its tabs. They reconnect to the new deploy,
   * whose `ready` event tells them to reload when their code is older.
   */
  shutdown() {
    this.stopping = true;
    this.emit("shutdown");
  }

  /** The server is stopping: new streams are turned away so they reach the new deploy. */
  stopping = false;

  private client: pg.PoolClient | null = null;
  private starting: Promise<void> | null = null;

  ensure(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.starting ??= this.connect().finally(() => (this.starting = null));
    return this.starting;
  }

  private async connect() {
    const client = await pool.connect();
    client.on("notification", (message) => {
      if (message.channel === NOTIFY_CHANNELS.chat && message.payload)
        this.emit("chat", message.payload);
      if (message.channel === NOTIFY_CHANNELS.app && message.payload)
        this.emit("app", message.payload);
    });
    client.on("error", () => {
      this.client = null;
      client.release(true);
    });
    await client.query(`listen ${NOTIFY_CHANNELS.chat}`);
    await client.query(`listen ${NOTIFY_CHANNELS.app}`);
    this.client = client;
  }
}

const globalForRealtime = globalThis as unknown as { openbotRealtime?: Realtime };
export const realtime = (globalForRealtime.openbotRealtime ??= new Realtime());
realtime.setMaxListeners(200);
