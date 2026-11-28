import type { VaultItemView } from "@open-bot/api";
import { VAULT_KINDS, vaultAccess, type VaultKind } from "@open-bot/domain";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Href } from "expo-router";
import { lastUsed } from "../../lib/time";

export const VAULT_HREF = "/vault" satisfies Href;
export const newVaultItemHref = (kind: VaultKind): Href => `/vault/new?kind=${kind}`;
export const vaultItemHref = (itemId: string): Href => `/vault/${itemId}`;
export const budgetHref = (teammateId: string): Href => `/vault/budget/${teammateId}`;

export const isVaultKind = (value: unknown): value is VaultKind =>
  typeof value === "string" && (VAULT_KINDS as readonly string[]).includes(value);

/** Logins, then cards, each as the server orders them (by name, ignoring case). */
export function vaultSections(items: readonly VaultItemView[]) {
  return {
    logins: items.filter((item) => item.kind === "login"),
    cards: items.filter((item) => item.kind === "card"),
  };
}

/** "Used 4h ago", or that no teammate has filled it in yet. */
export const usedText = (item: Pick<VaultItemView, "lastUsedAt">, now = Date.now()) =>
  item.lastUsedAt ? lastUsed(item.lastUsedAt, now) : "Not used yet";

/**
 * What a row says under an item's name: a login's username and site, then who may use it and when
 * it was last used. A card's brand and last four digits are on its face.
 */
export function itemDetails(
  item: VaultItemView,
  teammates: readonly { id: string; name: string }[],
  now = Date.now(),
): string[] {
  const access = vaultAccess(item.teammateIds, teammates).text;
  return item.kind === "login"
    ? [item.hint, item.domain ?? "", access, usedText(item, now)].filter(Boolean)
    : [item.hint, access, usedText(item, now)];
}

/** A card's face: its brand and last four digits, from "Visa •••• 4242". */
export function cardFace(hint: string): { brand: string; last4: string } {
  return { brand: hint.split(" ")[0] || "Card", last4: hint.slice(-4) };
}

/**
 * Takes an item out of the list at once, then deletes it. A read already on its way is called off
 * first, so its answer can't put the item back; a delete that fails puts the list back as it was.
 * Resolves with the delete's error, or null.
 */
export async function removeOptimistically<E>(
  client: QueryClient,
  key: QueryKey,
  itemId: string,
  write: () => Promise<{ error: E | null }>,
): Promise<E | null> {
  await client.cancelQueries({ queryKey: key, exact: true });
  const before = client.getQueryData<readonly VaultItemView[]>(key);
  client.setQueryData<readonly VaultItemView[]>(key, (current) =>
    current?.filter((entry) => entry.id !== itemId),
  );
  const { error } = await write();
  if (error) client.setQueryData(key, before);
  return error;
}

/**
 * The editor leaves to the vault once it's done: back when the vault is under it, or in its place
 * when it was opened from a link or search (`replace`), so Back never lands on a stale editor.
 */
export function editorReturnsToVault(previous: { name: string } | undefined): boolean {
  return previous?.name === "vault/index";
}
