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
 * SQL and every parameter. Rethrow this, but never show or log it whole: its `detail` can hold
 * values. `errorMessage` and `errorFields` say what may be shown. Anything else is returned as is.
 */
export function databaseError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  return error.cause instanceof Error ? error.cause : new Error("A database query failed.");
}

/**
 * An error's message for a person or a log. A database error says only its SQLSTATE: Postgres's
 * own message can repeat a value it refused (`invalid input syntax for type integer: "..."`).
 */
export function errorMessage(error: unknown): string {
  const shown = databaseError(error);
  if (shown instanceof pg.DatabaseError)
    return `The database refused the query (SQLSTATE ${shown.code ?? "unknown"}).`;
  return shown instanceof Error ? shown.message : String(shown);
}

/** Text that may hold a `DrizzleQueryError`'s message, without the parameters that end it. */
export function withoutParameters(text: string): string {
  return text.replace(/\nparams: [\s\S]*$/, "");
}

/**
 * An error as a log line may record it. A database error gives only its safe message, its SQL
 * without parameters, and what it names (code, table, column, constraint), never its `detail`
 * or `where`, which can hold values. Any other error keeps its stack.
 */
export function errorFields(error: unknown): Record<string, string | undefined> {
  const shown = databaseError(error);
  const fields: Record<string, string | undefined> = { error: errorMessage(error) };
  if (error instanceof DrizzleQueryError) fields.query = error.query;
  if (shown instanceof pg.DatabaseError)
    Object.assign(fields, {
      code: shown.code,
      table: shown.table,
      column: shown.column,
      constraint: shown.constraint,
    });
  else if (!(error instanceof DrizzleQueryError) && error instanceof Error)
    fields.stack = error.stack;
  return fields;
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
