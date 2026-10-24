import "server-only";
import { EventEmitter } from "node:events";
import { CHANNELS } from "@open-bot/db";
import type pg from "pg";
import { pool } from "./db";

/**
 * One Postgres LISTEN connection per server process, fanned out to every open SSE stream.
 * Emits `chat` (payload: chat id) and `app` (payload: JSON app event).
 */
class Realtime extends EventEmitter<{ chat: [string]; app: [string] }> {
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
      if (message.channel === CHANNELS.chat && message.payload) this.emit("chat", message.payload);
      if (message.channel === CHANNELS.app && message.payload) this.emit("app", message.payload);
    });
    client.on("error", () => {
      this.client = null;
      client.release(true);
    });
    await client.query(`listen ${CHANNELS.chat}`);
    await client.query(`listen ${CHANNELS.app}`);
    this.client = client;
  }
}

const globalForRealtime = globalThis as unknown as { openbotRealtime?: Realtime };
export const realtime = (globalForRealtime.openbotRealtime ??= new Realtime());
realtime.setMaxListeners(200);
