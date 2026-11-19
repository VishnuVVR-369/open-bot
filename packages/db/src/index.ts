import type { NotifyChannel } from "@open-bot/domain";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { SafeClient } from "./errors";
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

/**
 * A pool for `url`, which each app reads from its own env module. Its failed queries never carry a
 * value: see `errors.ts`.
 */
export function createPool(url: string): pg.Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url, max: 10, Client: SafeClient });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
/** Send on one of the NOTIFY channels (`NOTIFY_CHANNELS` in `@open-bot/domain`). */
export async function notify(
  client: Pick<pg.Pool, "query">,
  channel: NotifyChannel,
  payload: string,
): Promise<void> {
  await client.query("select pg_notify($1, $2)", [channel, payload]);
}
