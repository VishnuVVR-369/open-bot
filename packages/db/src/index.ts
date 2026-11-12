import { DrizzleQueryError } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export * from "./schema";
export { LOCKS, lockUntilCommit, withTryLock, type LockKey } from "./locks";
export {
  DEFAULT_TIME_ZONE,
  ownerSettings,
  ownerTimeZone,
  SETTINGS_ID,
  type OwnerSettings,
} from "./settings";
export { configurationRevision } from "./configuration";
export { schema };

export type Db = NodePgDatabase<typeof schema>;
/** A transaction, as `db.transaction` passes it. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Something that runs queries: the database, or a transaction in it. */
export type Queryable = Db | Tx;

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url, max: 10 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * The database's own error behind Drizzle's `DrizzleQueryError`, whose message repeats the failed
 * SQL and every parameter. Use it where a message can reach a person or a log; anything else is
 * returned as is.
 */
export function databaseError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause instanceof Error ? error.cause : error;
}

/**
 * Postgres NOTIFY channels.
 * - `chat`: payload is a chat id; something in that chat changed (events, messages, runs).
 * - `app`: payload is JSON `AppEvent` (`@open-bot/domain`); something app-wide changed.
 * - `worker`: payload is a `WorkerSignal`; wakes the worker.
 */
export const CHANNELS = {
  chat: "openbot_chat",
  app: "openbot_app",
  worker: "openbot_worker",
} as const;

export type WorkerSignal = "runs" | "schedules" | "triggers" | "cancel" | "accounts";

export async function notify(
  client: Pick<pg.Pool, "query">,
  channel: (typeof CHANNELS)[keyof typeof CHANNELS],
  payload: string,
): Promise<void> {
  await client.query("select pg_notify($1, $2)", [channel, payload]);
}
