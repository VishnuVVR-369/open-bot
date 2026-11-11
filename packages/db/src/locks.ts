import { sql } from "drizzle-orm";
import type pg from "pg";
import type { Tx } from "./index";

/**
 * Every Postgres advisory lock the apps take, by what it protects. Postgres has one key space for
 * them, so each key is named here, never inline. The web app and the worker deploy at different
 * times and must still exclude each other: never change a key that has shipped.
 *
 * A number is used as the key itself; a string is hashed with `hashtextextended(key, 0)`.
 */
export const LOCKS = {
  /**
   * Who is on the team and who leads: creating a teammate, archiving one and choosing the lead.
   * Take it before any other lock (`lockUntilCommit` takes numbers first).
   */
  team: 78123401,
  /**
   * One uploaded file: writing it, accepting a message that carries it, and cleaning it up. Cleanup
   * rechecks each candidate under this lock before deleting its file.
   */
  upload: (path: string) => path,
  /** Picking a connection name nobody has yet (names are unique). */
  connectionNames: "connection_names",
  /** One sign-in setup at a time per provider: only one client can be the current one. */
  oauthClients: (provider: string) => `oauth_clients:${provider}`,
  /** One teammate's memory, or the memory every teammate shares. Keys predate the glossary. */
  memory: (scope: `bot:${string}` | "shared") => scope, // vocabulary: allow
  /** One screen's input, held across botd calls (a session lock, see `withTryLock`). */
  screen: (screenId: string) => `screen:${screenId}`,
} as const;

export type LockKey = string | number;

const keySql = (key: LockKey) =>
  typeof key === "number" ? sql`${key}::bigint` : sql`hashtextextended(${key}, 0)`;

/** Numbers first, then strings in order, so two holders of the same keys can't deadlock. */
function ordered(keys: readonly LockKey[]): LockKey[] {
  const unique = [...new Set(keys)];
  const numbers = unique.filter((key): key is number => typeof key === "number");
  const strings = unique.filter((key): key is string => typeof key === "string");
  return [...numbers.sort((a, b) => a - b), ...strings.sort()];
}

/**
 * Hold these locks until the transaction ends. Takes a Drizzle transaction, or a `pg` client that
 * is inside `begin` (for code that still runs raw SQL); outside a transaction it would hold nothing.
 */
export async function lockUntilCommit(
  tx: Tx | pg.ClientBase,
  ...keys: readonly LockKey[]
): Promise<void> {
  for (const key of ordered(keys)) {
    if ("execute" in tx) await tx.execute(sql`select pg_advisory_xact_lock(${keySql(key)})`);
    else if (typeof key === "number")
      await tx.query("select pg_advisory_xact_lock($1::bigint)", [key]);
    else await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

/**
 * Run `action` holding a session lock, without a transaction open meanwhile (so it can span slow
 * calls to other services). Throws `busy()` without waiting when someone else holds it.
 */
export async function withTryLock<T>(
  pool: pg.Pool,
  key: string,
  busy: () => Error,
  action: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [key],
    );
    locked = result.rows[0]!.locked;
    if (!locked) throw busy();
    return await action();
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    } finally {
      client.release();
    }
  }
}
