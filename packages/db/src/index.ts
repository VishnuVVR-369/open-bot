import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export * from "./schema";
export { configurationRevision } from "./configuration";
export { schema };

export type Db = NodePgDatabase<typeof schema>;

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url, max: 10 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * Postgres NOTIFY channels.
 * - `chat`: payload is a chat id; something in that chat changed (events, messages, runs).
 * - `app`: payload is JSON `AppEvent`; something app-wide changed.
 * - `worker`: payload is a `WorkerSignal`; wakes the worker.
 */
export const CHANNELS = {
  chat: "openbot_chat",
  app: "openbot_app",
  worker: "openbot_worker",
} as const;

export type AppEvent =
  | { type: "memory" }
  | { type: "lease" }
  | { type: "computer" }
  | { type: "notification"; id: string }
  | { type: "approvals" }
  | { type: "takeovers" }
  | { type: "bots" }
  | { type: "chats" }
  | { type: "schedules" }
  | { type: "triggers" }
  | { type: "profile" }
  | { type: "lessons" }
  | { type: "tasks" }
  | { type: "telegram" }
  | { type: "skills" }
  | { type: "vault" }
  | { type: "connections" }
  | { type: "email" }
  | { type: "purchases" }
  | { type: "auth" };

export type WorkerSignal = "runs" | "schedules" | "triggers" | "cancel";

export async function notify(
  client: Pick<pg.Pool, "query">,
  channel: (typeof CHANNELS)[keyof typeof CHANNELS],
  payload: string,
): Promise<void> {
  await client.query("select pg_notify($1, $2)", [channel, payload]);
}
