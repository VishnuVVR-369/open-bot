import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { vaultItems } from "@open-bot/db";
import {
  cardHint,
  invalidCard,
  normalizeDomain,
  normalizeExpiry,
  type CardSecret,
  type LoginSecret,
} from "@open-bot/domain";
import { decryptSecret, encryptSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { serverEnv } from "../env";
import { publish } from "../publish";
import { ApiError } from "./errors";

type Inputs = ApiInputs["vault"];

/** A login's or card's secret, and the hint the vault shows of it, or why it can't be saved. */
function vaultSecret(
  kind: "login" | "card",
  fields: Record<string, string>,
  domainInput: string,
): { secret: LoginSecret | CardSecret; hint: string; domain: string | null } {
  if (kind === "login") {
    const domain = normalizeDomain(domainInput);
    if (!domain) throw new ApiError("BAD_REQUEST", "Give the site it's for, like github.com.");
    const username = (fields.username ?? "").trim();
    const password = fields.password ?? "";
    if (!username) throw new ApiError("BAD_REQUEST", "Add the username or email.");
    if (!password) throw new ApiError("BAD_REQUEST", "Add the password.");
    return { secret: { username, password }, hint: username, domain };
  }
  const card: CardSecret = {
    number: (fields.number ?? "").replace(/[\s-]/g, ""),
    expiry: normalizeExpiry(fields.expiry ?? "") ?? fields.expiry ?? "",
    cvc: (fields.cvc ?? "").trim(),
    name: (fields.name ?? "").trim(),
    zip: (fields.zip ?? "").trim(),
  };
  const problem = invalidCard(card);
  if (problem) throw new ApiError("BAD_REQUEST", problem);
  return { secret: card, hint: cardHint(card.number), domain: null };
}

/** Save a login or card. Secrets are encrypted here and never sent back to the browser. */
export async function saveVaultItem(input: Inputs["save"]): Promise<{ id: string }> {
  const saved = await db.transaction(async (tx) => {
    // Locked, so two edits at once each keep the other's fields instead of the last one winning.
    const [existing] = input.id
      ? await tx.select().from(vaultItems).where(eq(vaultItems.id, input.id)).for("update")
      : [];
    if (input.id && !existing)
      throw new ApiError("NOT_FOUND", "That item is no longer in the vault.");
    if (existing && existing.kind !== input.kind)
      throw new ApiError("BAD_REQUEST", "An item can't change its kind.");
    const fields: Record<string, string> = existing
      ? JSON.parse(decryptSecret(existing.encrypted, serverEnv.encryptionKey))
      : {};
    // Fields left empty keep what's saved, except the username: the form shows it, so an empty
    // one was cleared.
    for (const [field, value] of Object.entries(input.secret))
      if (value.trim() || field === "username") fields[field] = value;
    const { secret, hint, domain } = vaultSecret(input.kind, fields, input.domain);
    const values = {
      kind: input.kind,
      name: input.name,
      domain,
      hint,
      botIds: input.teammateIds,
      encrypted: encryptSecret(JSON.stringify(secret), serverEnv.encryptionKey),
    };
    const [row] = existing
      ? await tx
          .update(vaultItems)
          .set(values)
          .where(eq(vaultItems.id, existing.id))
          .returning({ id: vaultItems.id })
      : await tx.insert(vaultItems).values(values).returning({ id: vaultItems.id });
    return row!;
  });
  await publish({ type: "vault" });
  return saved;
}

export async function removeVaultItem({ itemId }: Inputs["remove"]): Promise<{ ok: true }> {
  await db.delete(vaultItems).where(eq(vaultItems.id, itemId));
  await publish({ type: "vault" });
  return { ok: true };
}
