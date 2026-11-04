import { sql } from "drizzle-orm";
import type { Tx } from "./index";

/**
 * Upload writes, message acceptance and cleanup must hold the same path lock through commit.
 * Cleanup rechecks each candidate's eligibility under that lock before deleting its file.
 * Sort paths so messages with several attachments cannot deadlock each other.
 */
export async function lockUploads(tx: Tx, paths: readonly string[]): Promise<void> {
  for (const path of [...new Set(paths)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${path}, 0))`);
}
