import { vaultItems } from "@open-bot/db";
import { decryptSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, worker, racedWhileLocked } = h;

  describe("vault, page and notification writes", () => {
    const login = {
      id: null,
      kind: "login" as const,
      name: "GitHub",
      domain: "https://github.com/login",
      teammateIds: null,
      secret: { username: "alex", password: "hunter22" },
    };
    const vaultSecret = async (itemId: string): Promise<Record<string, string>> => {
      const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, itemId));
      return JSON.parse(decryptSecret(row!.encrypted, ctx.env.ENCRYPTION_KEY));
    };

    it("saves a login encrypted, keeps fields left empty when editing, and removes it", async () => {
      const { id } = await worker.vault.save(login);
      const [saved] = await db.select().from(vaultItems).where(eq(vaultItems.id, id));
      expect(saved).toMatchObject({ domain: "github.com", hint: "alex" });
      expect(saved!.encrypted).not.toContain("hunter22");
      await worker.vault.save({
        ...login,
        id,
        name: "GitHub work",
        secret: { username: "alex", password: "" },
      });
      expect(await vaultSecret(id)).toEqual({ username: "alex", password: "hunter22" });
      expect(await failure(worker.vault.save({ ...login, id, kind: "card" }))).toEqual({
        status: 400,
        message: "An item can't change its kind.",
      });
      expect(await failure(worker.vault.save({ ...login, id: ID }))).toEqual({
        status: 404,
        message: "That item is no longer in the vault.",
      });
      expect(await failure(worker.vault.save({ ...login, secret: { username: "alex" } }))).toEqual({
        status: 400,
        message: "Add the password.",
      });
      await worker.vault.remove({ itemId: id });
      await worker.vault.remove({ itemId: id });
      expect(await db.select().from(vaultItems).where(eq(vaultItems.id, id))).toEqual([]);
    });

    it("keeps both of two card edits made at once", async () => {
      const card = {
        id: null,
        kind: "card" as const,
        name: "Visa",
        domain: "",
        teammateIds: null,
        secret: {
          number: "4242 4242 4242 4242",
          expiry: "12/40",
          cvc: "123",
          name: "Alex",
          zip: "",
        },
      };
      const { id } = await worker.vault.save(card);
      const edit = (secret: Record<string, string>) => worker.vault.save({ ...card, id, secret });
      await racedWhileLocked(
        "select 1 from vault_items where id = $1 for update",
        () => [edit({ cvc: "999" }), edit({ zip: "10115" })],
        [id],
      );
      expect(await vaultSecret(id)).toMatchObject({ cvc: "999", zip: "10115" });
      await worker.vault.remove({ itemId: id });
    });
  });
});
