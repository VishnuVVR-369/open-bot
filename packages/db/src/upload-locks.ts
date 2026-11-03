import { sql } from "drizzle-orm";
import type { Tx } from "./index";

export async function lockUploads(tx: Tx, paths: readonly string[]): Promise<void> {
  for (const path of [...new Set(paths)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${path}, 0))`);
}
