import { vaultItems } from "@open-bot/db";
import { decryptSecret } from "@open-bot/domain/server";
import { randomUUID } from "node:crypto";
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

    it("adds a new item once under the client's id, however often it's sent", async () => {
      const id = randomUUID();
      const { id: _, ...fields } = login;
      const item = { ...fields, id };
      expect(await worker.vault.create(item)).toEqual({ id, created: true });
      // The answer was lost and the phone sends it again: the item it made, not a second one.
      expect(await worker.vault.create(item)).toEqual({ id, created: false });
      // Renamed on the web before the retry came: still the same item.
      await worker.vault.patch({ itemId: id, name: "GitHub (web)" });
      expect(await worker.vault.create(item)).toEqual({ id, created: false });
      const rows = await db.select().from(vaultItems).where(eq(vaultItems.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "GitHub (web)", domain: "github.com", hint: "alex" });

      // The same id for something else isn't a retry, and changes nothing.
      const reused = [
        { ...item, secret: { username: "someone-else", password: "made-up-pass" } },
        { ...item, domain: "gitlab.com" },
        {
          ...item,
          kind: "card" as const,
          secret: { number: "4242424242424242", expiry: "12/40", cvc: "123", name: "A", zip: "" },
        },
      ];
      for (const other of reused)
        expect(await failure(worker.vault.create(other))).toEqual({
          status: 409,
          message: "That vault id was already used for something else.",
        });
      expect(await vaultSecret(id)).toEqual({ username: "alex", password: "hunter22" });

      // Two tries at once (a retry while the first is still on its way): one item.
      const raced = randomUUID();
      const answers = await Promise.all([
        worker.vault.create({ ...item, id: raced }),
        worker.vault.create({ ...item, id: raced }),
      ]);
      expect(answers.map((answer) => answer.created).sort()).toEqual([false, true]);
      expect(await db.select().from(vaultItems).where(eq(vaultItems.id, raced))).toHaveLength(1);
      await worker.vault.remove({ itemId: id });
      await worker.vault.remove({ itemId: raced });
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

    it("patches only what's given, so an edit made elsewhere meanwhile stays", async () => {
      const { id } = await worker.vault.save(login);
      const teammate = (await h.newTeammate("Vault user", "helper")).id;
      // Renamed and limited on the web while the phone's edit was open.
      await worker.vault.save({ ...login, id, name: "GitHub (web)", teammateIds: [teammate] });
      await worker.vault.patch({ itemId: id, secret: { password: "new-pass" } });
      const read = async () =>
        (await db.select().from(vaultItems).where(eq(vaultItems.id, id)))[0]!;
      expect(await read()).toMatchObject({
        name: "GitHub (web)",
        domain: "github.com",
        hint: "alex",
        teammateIds: [teammate],
      });
      expect(await vaultSecret(id)).toEqual({ username: "alex", password: "new-pass" });

      // Each field on its own: the site, the username, and back to every teammate.
      await worker.vault.patch({
        itemId: id,
        domain: "https://gist.github.com/",
        teammateIds: null,
        secret: { username: "octo", password: "" },
      });
      expect(await read()).toMatchObject({
        name: "GitHub (web)",
        domain: "gist.github.com",
        hint: "octo",
        teammateIds: null,
      });
      expect(await vaultSecret(id)).toEqual({ username: "octo", password: "new-pass" });
      expect(await failure(worker.vault.patch({ itemId: id, secret: { username: " " } }))).toEqual({
        status: 400,
        message: "Add the username or email.",
      });
      expect(await failure(worker.vault.patch({ itemId: id, domain: "not a site" }))).toEqual({
        status: 400,
        message: "Give the site it's for, like github.com.",
      });
      expect(await failure(worker.vault.patch({ itemId: id }))).toMatchObject({ status: 400 });
      await worker.vault.remove({ itemId: id });
      expect(await failure(worker.vault.patch({ itemId: id, name: "Gone" }))).toEqual({
        status: 404,
        message: "That item is no longer in the vault.",
      });
    });

    it("keeps both of two patches made at once, and refuses a card's site", async () => {
      const { id } = await worker.vault.save({
        id: null,
        kind: "card",
        name: "Visa",
        domain: "",
        teammateIds: null,
        secret: { number: "4242424242424242", expiry: "1240", cvc: "123", name: "Alex", zip: "" },
      });
      await racedWhileLocked(
        "select 1 from vault_items where id = $1 for update",
        () => [
          worker.vault.patch({ itemId: id, name: "Visa (renamed)" }),
          worker.vault.patch({ itemId: id, secret: { cvc: "999" } }),
        ],
        [id],
      );
      const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, id));
      expect(row).toMatchObject({ name: "Visa (renamed)", hint: "Visa •••• 4242" });
      expect(await vaultSecret(id)).toMatchObject({ cvc: "999", expiry: "12/40", name: "Alex" });
      expect(await failure(worker.vault.patch({ itemId: id, domain: "shop.com" }))).toEqual({
        status: 400,
        message: "A card has no site.",
      });
      expect(
        await failure(worker.vault.patch({ itemId: id, secret: { number: "4242424242424241" } })),
      ).toEqual({ status: 400, message: "That card number isn't valid." });
      await worker.vault.remove({ itemId: id });
    });
  });
});
