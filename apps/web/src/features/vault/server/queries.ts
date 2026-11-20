import "server-only";
import { vaultItems } from "@open-bot/db";
import { asc, sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { VaultItemView } from "@/lib/types";

/** Cards, then logins (by kind), each by name ignoring case. The secret is never read: the worker alone decrypts it. */
export async function listVaultItems(): Promise<VaultItemView[]> {
  const rows = await db
    .select({
      id: vaultItems.id,
      kind: vaultItems.kind,
      name: vaultItems.name,
      domain: vaultItems.domain,
      hint: vaultItems.hint,
      teammateIds: vaultItems.teammateIds,
      lastUsedAt: vaultItems.lastUsedAt,
      updatedAt: vaultItems.updatedAt,
    })
    .from(vaultItems)
    .orderBy(asc(vaultItems.kind), asc(sql`lower(${vaultItems.name})`));
  return rows.map((row) => ({
    ...row,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
