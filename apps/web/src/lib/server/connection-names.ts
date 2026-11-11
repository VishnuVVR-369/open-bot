import "server-only";
import { connections, LOCKS, lockUntilCommit, type Tx } from "@open-bot/db";

/**
 * A name no connection has yet, `base` or else `base_2`, `base_3`, ..., held for this transaction:
 * a lock keeps two connections saved at once from picking the same one (names are unique).
 */
export async function claimConnectionName(tx: Tx, base: string): Promise<string> {
  await lockUntilCommit(tx, LOCKS.connectionNames);
  const taken = new Set(
    (await tx.select({ name: connections.name }).from(connections)).map((row) => row.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}
