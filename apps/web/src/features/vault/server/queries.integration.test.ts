import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { vaultItems } from "@open-bot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = testDatabaseServer();

describe.skipIf(!url)("the vault's read", () => {
  const database = testDatabase(url);
  let listVaultItems: typeof import("./queries").listVaultItems;

  beforeAll(async () => {
    await database.create();
    process.env.DATABASE_URL = database.url;
    ({ listVaultItems } = await import("./queries"));
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/server/db");
    await pool.end();
    await database.drop();
  });

  it("lists logins, then cards, by name ignoring case, and never the secret", async () => {
    const used = new Date(Date.UTC(2026, 9, 2));
    const item = (kind: "login" | "card", name: string) => ({
      kind,
      name,
      hint: `${name} hint`,
      encrypted: `sealed ${name}`,
    });
    await database.db
      .insert(vaultItems)
      .values([
        item("card", "Visa"),
        { ...item("login", "github"), lastUsedAt: used },
        item("login", "Amazon"),
        item("card", "amex"),
      ]);

    const items = await listVaultItems();

    expect(items.map((entry) => `${entry.kind} ${entry.name}`)).toEqual([
      "card amex",
      "card Visa",
      "login Amazon",
      "login github",
    ]);
    expect(items[3]).toMatchObject({ hint: "github hint", lastUsedAt: used.toISOString() });
    expect(items[0]?.lastUsedAt).toBeNull();
    expect(items.every((entry) => typeof entry.updatedAt === "string")).toBe(true);
    expect(items.some((entry) => "encrypted" in entry)).toBe(false);
  });
});
