import { randomUUID } from "node:crypto";
import { accountActions, accounts, approvals, connections, oauthClients } from "@open-bot/db";
import { decryptSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, accountStore, accountActionLoop, worker, racedWhileLocked, teammateWithRun } = h;

  describe("connection, account and phone writes", () => {
    const server = {
      id: null,
      label: "Linear",
      transport: "http" as const,
      url: "https://mcp.linear.test/mcp",
      command: "",
      args: "",
      secrets: "Authorization: Bearer abc",
      teammateIds: null,
    };
    const connection = async (id: string) =>
      (await db.select().from(connections).where(eq(connections.id, id)))[0];

    /** A Google account with a Gmail connection, and a teammate's action waiting on it. */
    async function gmailWithWaitingAction() {
      const [client] = await db
        .insert(oauthClients)
        .values({ provider: "google", source: "owner", clientId: `client-${randomUUID()}` })
        .returning();
      const [account] = await db
        .insert(accounts)
        .values({
          provider: "google",
          externalId: `sub-${randomUUID()}`,
          oauthClientId: client!.id,
          display: "alex@example.test",
          encrypted: "not-read-here",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        })
        .returning();
      const linked = await worker.connections.linkAccount({
        accountId: account!.id,
        kind: "gmail",
        capabilities: ["read", "made-up"],
        teammateIds: null,
      });
      const { created, run } = await teammateWithRun();
      // Made like a teammate's action: under the account's grant and the connection's setup now.
      const waiting = async () => {
        const [current] = await db
          .select({ grantRevision: accounts.grantRevision })
          .from(accounts)
          .where(eq(accounts.id, account!.id));
        const [approval] = await db
          .insert(approvals)
          .values({
            runId: run.id,
            teammateId: created.id,
            chatId: created.chatId,
            kind: "account_outward",
            title: "Send it",
            itemId: `approval-${randomUUID()}`,
          })
          .returning();
        const [action] = await db
          .insert(accountActions)
          .values({
            connectionId: linked.connectionId,
            accountId: account!.id,
            grantRevision: current!.grantRevision,
            connectionRevision: (await connection(linked.connectionId))!.revision,
            teammateId: created.id,
            runId: run.id,
            chatId: created.chatId,
            itemId: `item-${randomUUID()}`,
            tool: "gmail.send_draft",
            effect: "outward",
            request: {},
            summary: "Send it",
            labels: { waiting: "Waiting", done: "Sent", failed: "Didn't send" },
            status: "pending",
            approvalId: approval!.id,
            expiresAt: new Date(Date.now() + 86_400_000),
          })
          .returning();
        return { actionId: action!.id, approvalId: approval!.id };
      };
      const outcome = async ({ actionId, approvalId }: Awaited<ReturnType<typeof waiting>>) => ({
        action: (await db.select().from(accountActions).where(eq(accountActions.id, actionId)))[0]!
          .status,
        approval: (await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!
          .status,
      });
      return { account: account!, connectionId: linked.connectionId, waiting, outcome };
    }

    it("saves an MCP server, keeps its headers when left empty, and names copies apart", async () => {
      const { id } = await worker.connections.save(server);
      await worker.connections.save({ ...server, id, label: "Linear (work)", secrets: "" });
      const saved = await connection(id);
      expect(saved).toMatchObject({
        label: "Linear (work)",
        name: "linear",
        secretNames: ["Authorization"],
      });
      expect(JSON.parse(decryptSecret(saved!.encrypted!, ctx.env.ENCRYPTION_KEY))).toEqual({
        headers: { Authorization: "Bearer abc" },
      });

      // Names are unique: three saves held at once each get their own.
      const copies = await racedWhileLocked("lock table connections in exclusive mode", () =>
        [1, 2, 3].map(() => worker.connections.save(server)),
      );
      const names = await Promise.all(
        copies.map(async (copy) => (await connection(copy.id))!.name),
      );
      expect(names.sort()).toEqual(["linear_2", "linear_3", "linear_4"]);

      expect(
        await failure(worker.connections.save({ ...server, transport: "stdio", command: "" })),
      ).toEqual({ status: 400, message: "Give the command the computer runs." });
      expect(await failure(worker.connections.save({ ...server, id: ID }))).toEqual({
        status: 404,
        message: "That connection is gone.",
      });
      await worker.connections.setEnabled({ connectionId: id, enabled: false });
      expect((await connection(id))!.enabled).toBe(false);
      expect(
        await failure(worker.connections.setEnabled({ connectionId: ID, enabled: true })),
      ).toEqual({ status: 404, message: "That connection is gone." });
      for (const copy of [{ id }, ...copies])
        expect(await worker.connections.remove({ connectionId: copy.id })).toEqual({
          warning: null,
        });
      expect(await connection(id)).toBeUndefined();
      expect(accountStore.revoke).not.toHaveBeenCalled();
    });

    it("links an account once, and cancels what waits on a connection that changes or goes", async () => {
      const gmail = await gmailWithWaitingAction();
      const linked = (await connection(gmail.connectionId))!;
      expect(linked).toMatchObject({ kind: "gmail", label: "Gmail", capabilities: ["read"] });
      expect(await failure(worker.connections.save({ ...server, id: gmail.connectionId }))).toEqual(
        { status: 400, message: "That's an account, not an MCP server." },
      );

      // Signing in again for the same access changes nothing.
      const again = {
        accountId: gmail.account.id,
        kind: "gmail" as const,
        capabilities: ["read"],
        teammateIds: null,
      };
      let action = await gmail.waiting();
      await worker.connections.linkAccount(again);
      expect((await connection(gmail.connectionId))!.revision).toBe(linked.revision);
      expect(await gmail.outcome(action)).toEqual({ action: "pending", approval: "pending" });
      // A sign-in that changed the grant (saveGrant moved its revision on), whose call here failed:
      // trying again still cancels what waits on the earlier grant, and only that.
      await db.update(accounts).set({ grantRevision: 2 }).where(eq(accounts.id, gmail.account.id));
      await worker.connections.linkAccount(again);
      expect(await gmail.outcome(action)).toEqual({ action: "cancelled", approval: "expired" });
      expect(accountActionLoop.kick).toHaveBeenCalled();
      const madeUnderNewGrant = await gmail.waiting();
      await worker.connections.linkAccount(again);
      expect(await gmail.outcome(madeUnderNewGrant)).toEqual({
        action: "pending",
        approval: "pending",
      });

      // Asking for more than the account granted changes nothing.
      const change = {
        connectionId: gmail.connectionId,
        capabilities: ["read"],
        teammateIds: null,
        askBeforeActing: false,
      };
      action = await gmail.waiting();
      expect(
        await worker.connections.updateAccount({ ...change, capabilities: ["read", "compose"] }),
      ).toEqual({ needsConsent: true });
      // How it asks isn't a new setup; who uses it is.
      expect(await worker.connections.updateAccount(change)).toEqual({ needsConsent: false });
      expect(await gmail.outcome(action)).toEqual({ action: "pending", approval: "pending" });
      const { created } = await teammateWithRun();
      await worker.connections.updateAccount({ ...change, teammateIds: [created.id] });
      expect(await gmail.outcome(action)).toEqual({ action: "cancelled", approval: "expired" });
      expect((await connection(gmail.connectionId))!.revision).toBeGreaterThan(linked.revision);
      expect(
        await failure(worker.connections.updateAccount({ ...change, connectionId: ID })),
      ).toEqual({ status: 404, message: "That connection is gone." });
      expect(
        await failure(
          worker.connections.updateAccount({ ...change, settings: { nothing: "here" } }),
        ),
      ).toMatchObject({ status: 400 });

      action = await gmail.waiting();
      await worker.connections.setEnabled({ connectionId: gmail.connectionId, enabled: false });
      expect(await gmail.outcome(action)).toEqual({ action: "cancelled", approval: "expired" });

      // The last connection out revokes the account.
      action = await gmail.waiting();
      expect(await worker.connections.remove({ connectionId: gmail.connectionId })).toEqual({
        warning: null,
      });
      expect(await gmail.outcome(action)).toMatchObject({ approval: "expired" });
      expect(accountStore.revoke).toHaveBeenCalledWith(gmail.account.id);
    });
  });
});
