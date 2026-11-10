import { sql } from "drizzle-orm";
import type { Tx } from "./index";

/**
 * The advisory lock every new teammate is created under, by the worker and the web app alike, so
 * two at once can't take the same slug or both become the lead. Keep the key: a worker and a web
 * app deployed at different times must still exclude each other.
 */
const TEAMMATE_CREATION_LOCK = 78123401;

/** Hold the teammate creation lock until the transaction ends. */
export async function lockTeammateCreation(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TEAMMATE_CREATION_LOCK})`);
}
