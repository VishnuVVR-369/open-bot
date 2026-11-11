import "server-only";
import { connections, type Tx } from "@open-bot/db";
import { sql } from "drizzle-orm";

/**
 * A name no connection has yet, `base` or else `base_2`, `base_3`, ..., held for this transaction:
 * a lock keeps two connections saved at once from picking the same one (names are unique).
 */
export async function claimConnectionName(tx: Tx, base: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('connection_names', 0))`);
  const taken = new Set(
    (await tx.select({ name: connections.name }).from(connections)).map((row) => row.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}
