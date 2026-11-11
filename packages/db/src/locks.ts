import { sql } from "drizzle-orm";
import type pg from "pg";
import type { Tx } from "./index";

/**
 * Every Postgres advisory lock the apps take, by what it protects. Postgres has one key space for
 * them, so each key is named here, never inline. The web app and the worker deploy at different
 * times and must still exclude each other: never change a key that has shipped.
 *
 * A number is used as the key itself; a string is hashed with `hashtextextended(key, 0)`; a
 * `{ hashtext }` key is hashed with `hashtext`, for a lock that shipped that way.
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
  /**
   * One sign-in setup at a time per provider: only one client can be the current one. It shipped
   * hashed with `hashtext`, so it stays that way.
   */
  oauthClients: (provider: string): LegacyKey => ({ hashtext: `oauth_clients:${provider}` }),
  /** One teammate's memory, or the memory every teammate shares. Keys predate the glossary. */
  memory: (scope: `bot:${string}` | "shared") => scope, // vocabulary: allow
  /** One screen's input, held across botd calls (a session lock, see `withTryLock`). */
  screen: (screenId: string) => `screen:${screenId}`,
  /** Which of a teammate's chats is its main chat: choosing, handing on or making one. */
  mainChat: (teammateId: string) => `main_chat:${teammateId}`,
} as const;

/** A key hashed with `hashtext`, as a lock that shipped before `hashtextextended` was the rule. */
export type LegacyKey = { readonly hashtext: string };
export type LockKey = string | number | LegacyKey;

/** The lock's key as SQL and as a `pg` query with its one parameter. */
function keyOf(key: LockKey) {
  if (typeof key === "number") return { sql: sql`${key}::bigint`, text: "$1::bigint", value: key };
  if (typeof key === "string")
    return { sql: sql`hashtextextended(${key}, 0)`, text: "hashtextextended($1, 0)", value: key };
  return { sql: sql`hashtext(${key.hashtext})`, text: "hashtext($1)", value: key.hashtext };
}

/** Numbers first, then strings, then legacy keys, in order, so two holders can't deadlock. */
function ordered(keys: readonly LockKey[]): LockKey[] {
  const numbers = new Set<number>();
  const strings = new Set<string>();
  const legacy = new Set<string>();
  for (const key of keys) {
    if (typeof key === "number") numbers.add(key);
    else if (typeof key === "string") strings.add(key);
    else legacy.add(key.hashtext);
  }
  return [
    ...[...numbers].sort((a, b) => a - b),
    ...[...strings].sort(),
    ...[...legacy].sort().map((hashtext) => ({ hashtext })),
  ];
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
    const lock = keyOf(key);
    if ("execute" in tx) await tx.execute(sql`select pg_advisory_xact_lock(${lock.sql})`);
    else await tx.query(`select pg_advisory_xact_lock(${lock.text})`, [lock.value]);
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
