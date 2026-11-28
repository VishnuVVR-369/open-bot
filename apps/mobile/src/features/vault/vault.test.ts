import type { VaultItemView } from "@open-bot/api";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  cardFace,
  editorReturnsToVault,
  isVaultKind,
  itemDetails,
  removeOptimistically,
  usedText,
  vaultSections,
} from "./vault";

const now = new Date("2026-11-28T12:00:00").getTime();
const login: VaultItemView = {
  id: "l",
  kind: "login",
  name: "GitHub",
  domain: "github.com",
  hint: "octo@example.com",
  teammateIds: null,
  lastUsedAt: new Date(now - 3 * 3_600_000).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
const card: VaultItemView = {
  id: "c",
  kind: "card",
  name: "Visa",
  domain: null,
  hint: "Visa •••• 4242",
  teammateIds: ["a"],
  lastUsedAt: null,
  updatedAt: new Date(now).toISOString(),
};
const teammates = [{ id: "a", name: "Ava" }];

describe("the vault's list", () => {
  it("puts logins and cards in their sections", () => {
    expect(vaultSections([card, login])).toEqual({ logins: [login], cards: [card] });
  });

  it("says what each item is, who may use it and when it was used", () => {
    expect(itemDetails(login, teammates, now)).toEqual([
      "octo@example.com",
      "github.com",
      "Every teammate",
      "Used 3h ago",
    ]);
    expect(itemDetails(card, teammates, now)).toEqual([
      "Visa •••• 4242",
      "Only Ava",
      "Not used yet",
    ]);
    expect(usedText({ lastUsedAt: new Date(now - 30_000).toISOString() }, now)).toBe(
      "Used just now",
    );
  });

  it("draws a card's face from its hint", () => {
    expect(cardFace("Amex •••• 0005")).toEqual({ brand: "Amex", last4: "0005" });
    expect(cardFace("")).toEqual({ brand: "Card", last4: "" });
  });

  it("knows a vault kind", () => {
    expect(isVaultKind("card")).toBe(true);
    expect(isVaultKind("note")).toBe(false);
    expect(isVaultKind(undefined)).toBe(false);
  });

  it("goes back to the vault only when it's right under the editor", () => {
    expect(editorReturnsToVault({ name: "vault/index" })).toBe(true);
    expect(editorReturnsToVault({ name: "search" })).toBe(false);
    expect(editorReturnsToVault(undefined)).toBe(false);
  });
});

describe("deleting an item", () => {
  const KEY = ["vault", "list"];

  it("takes it out of the list while the delete is on its way", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, [login, card]);
    let seen: unknown;
    const error = await removeOptimistically(client, KEY, "l", async () => {
      seen = client.getQueryData(KEY);
      return { error: null };
    });
    expect(error).toBeNull();
    expect(seen).toEqual([card]);
  });

  it("puts it back when the delete fails", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, [login, card]);
    const failure = new Error("Couldn't reach open-bot.");
    expect(await removeOptimistically(client, KEY, "c", async () => ({ error: failure }))).toBe(
      failure,
    );
    expect(client.getQueryData(KEY)).toEqual([login, card]);
  });

  it("calls off a read from before the tap, so its answer can't bring the item back", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, [login, card]);
    let answer: (items: VaultItemView[]) => void = () => {};
    const reading = client.fetchQuery({
      queryKey: KEY,
      queryFn: () => new Promise<VaultItemView[]>((resolve) => (answer = resolve)),
      staleTime: 0,
    });
    await removeOptimistically(client, KEY, "l", async () => {
      answer([login, card]);
      return { error: null };
    });
    await reading.catch(() => {});
    expect(client.getQueryData(KEY)).toEqual([card]);
  });
});
