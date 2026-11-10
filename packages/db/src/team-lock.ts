import { sql } from "drizzle-orm";
import type { Tx } from "./index";

/**
 * The advisory lock taken by everything that changes who is on the team or who leads: creating a
 * teammate (the worker and the web app alike), archiving one, and choosing the lead. Keep the key:
 * a worker and a web app deployed at different times must still exclude each other.
 */
const TEAM_LOCK = 78123401;

/** Hold the team lock until the transaction ends. Take it before any other lock. */
export async function lockTeam(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TEAM_LOCK})`);
}
