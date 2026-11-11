import { credentials, type Queryable } from "@open-bot/db";
import { encryptSecret, secretHint } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import type { Context } from "../context";

/** The secrets open-bot keeps, encrypted, one per kind. Only this module writes them. */

export type CredentialKind = (typeof credentials.$inferInsert)["kind"];

type Writer = Pick<Context, "env"> & { db: Queryable };

/**
 * Save a secret as `kind`, replacing the one saved before. `hint` is what the owner sees of it
 * (the secret's own ends unless given).
 */
export async function saveCredential(
  ctx: Writer,
  kind: CredentialKind,
  secret: string,
  hint = secretHint(secret),
): Promise<void> {
  const encrypted = encryptSecret(secret, ctx.env.ENCRYPTION_KEY);
  await ctx.db
    .insert(credentials)
    .values({ kind, encrypted, hint })
    .onConflictDoUpdate({ target: credentials.kind, set: { encrypted, hint } });
}

/** Save a secret as `kind` unless one is saved already (another process may have made it first). */
export async function addCredential(
  ctx: Writer,
  kind: CredentialKind,
  secret: string,
  hint: string,
): Promise<void> {
  await ctx.db
    .insert(credentials)
    .values({ kind, encrypted: encryptSecret(secret, ctx.env.ENCRYPTION_KEY), hint })
    .onConflictDoNothing();
}

export async function removeCredential(db: Queryable, kind: CredentialKind): Promise<void> {
  await db.delete(credentials).where(eq(credentials.kind, kind));
}
