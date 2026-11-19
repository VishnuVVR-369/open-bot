import type { NotifyChannel } from "@open-bot/domain";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { SafeClient, withoutValues } from "./errors";
import type { Db } from "./queryable";
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
export { apiKeySpendMicros } from "./usage";
export { configurationRevision } from "./configuration";
export { databaseError, errorFields, errorMessage, withoutValues } from "./errors";
export { schema };

export type { Db, Queryable, Tx } from "./queryable";

export interface PoolOptions {
  /**
   * An idle connection failed, as every one does when the database restarts or ends it. The pool
   * has already dropped that connection and opens a new one when it is next needed; this only
   * reports it. The error has no values in it (`withoutValues`).
   * Without a listener, the pool's 'error' event would end the process.
   */
  onIdleError(error: Error): void;
}

/**
 * A pool for `url`, which each app reads from its own env module. Its failed queries never carry a
 * value: see `errors.ts`.
 * A connection that fails never ends the process. The pool reports one it holds (`onIdleError`).
 * One taken out with `pool.connect()`, by a transaction say, fails its next query instead, so
 * whoever holds it hears about it; one kept to LISTEN adds its own 'error' listener to replace it.
 */
export function createPool(url: string, options: PoolOptions): pg.Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url, max: 10, Client: SafeClient });
  pool.on("error", (error) => options.onIdleError(withoutValues(error)));
  // The pool listens to a connection only while it holds it: taken out, a failed one emits 'error'
  // with nothing listening, which would end the process.
  pool.on("connect", (client) => client.on("error", () => {}));
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/** Send on one of the NOTIFY channels (`NOTIFY_CHANNELS` in `@open-bot/domain`). */
export async function notify(
  client: Pick<pg.Pool, "query">,
  channel: NotifyChannel,
  payload: string,
): Promise<void> {
  await client.query("select pg_notify($1, $2)", [channel, payload]);
}
