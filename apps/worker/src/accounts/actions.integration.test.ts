import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { AccountStore } from "@open-bot/accounts";
import {
  accountActions,
  accounts,
  approvals,
  bots,
  chats,
  connections,
  createDb,
  createPool,
  oauthClients,
  runs,
} from "@open-bot/db";
import { ACCOUNT_CONNECTION_KINDS, GOOGLE_SCOPES } from "@open-bot/shared";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { ApprovalService } from "../services/approvals";
import { SessionRegistry } from "../services/registry";
import { AccountAccess, AccountToolError } from "./access";
import { AccountActions } from "./actions";
import { ProviderError } from "./http";
import { Integrations } from "./registry";
import type { ActionOutcome, ActionRunner, IntegrationAdapter } from "./types";

const url = process.env.MOBILE_API_TEST_DATABASE_URL;

/** The executor's sweep, which start() runs every 30 seconds, called directly to await it. */
const sweep = (actions: AccountActions) =>
  (actions as unknown as { sweep(): Promise<void> }).sweep();

describe.skipIf(!url)("account actions with Postgres", () => {
  const pool = createPool(url ?? "postgres://unused");
  const db = createDb(pool);
  const key = randomBytes(32).toString("base64");
  const ctx = {
    db,
    pool,
    events: new EventEmitter(),
    env: { APP_URL: "https://openbot.test", ENCRYPTION_KEY: key },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const sessions = new SessionRegistry();
  const approvalService = new ApprovalService(ctx, sessions);
  const access = new AccountAccess(ctx);

  const done: ActionOutcome = { status: "done", message: "Sent." };
  const runner = {
    execute: vi.fn<ActionRunner["execute"]>(),
    reconcile: vi.fn<ActionRunner["reconcile"]>(),
  };
  /** Every integration, with the same stand-in runner. */
  const integrations = new Integrations(
    ACCOUNT_CONNECTION_KINDS.map((kind): IntegrationAdapter => ({
      kind,
      call: vi.fn(),
      probe: vi.fn(),
      problem: (error) => error.message,
      runner,
    })),
  );
  /** Two workers, as during a deploy: each with its own memory, sharing the database. */
  const first = new AccountActions(ctx, sessions, approvalService, access, integrations);
  const second = new AccountActions(
    ctx,
    new SessionRegistry(),
    approvalService,
    access,
    integrations,
  );

  let fixture: {
    botId: string;
    chatId: string;
    runId: string;
    connectionId: string;
    accountId: string;
  };

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/openbot_mobile_api_test")
      throw new Error(
        "Use the disposable openbot_mobile_api_test database (pnpm test:mobile-api).",
      );
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url)),
    });
  });

  beforeEach(async () => {
    await pool.query(
      "truncate bots, chats, connections, accounts, oauth_clients restart identity cascade",
    );
    runner.execute.mockReset().mockResolvedValue(done);
    runner.reconcile.mockReset().mockResolvedValue(null);
    const [bot] = await db
      .insert(bots)
      .values({ name: "Iris", slug: "iris", role: "assistant", color: "#4f46e5" })
      .returning();
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: "Iris", botId: bot!.id })
      .returning();
    const [run] = await db
      .insert(runs)
      .values({
        chatId: chat!.id,
        botId: bot!.id,
        trigger: "user",
        prompt: "Reply",
        status: "completed",
      })
      .returning();
    const store = new AccountStore(db, key);
    const client = await store.clients.makeCurrent({
      provider: "google",
      source: "owner",
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "secret-1234567",
      hint: null,
    });
    const { account } = await store.saveGrant({
      provider: "google",
      externalId: "sub-1",
      oauthClientId: client.id,
      display: "me@example.com",
      tokens: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3600_000,
        tokenType: "Bearer",
        scope: `openid email ${GOOGLE_SCOPES.gmailRead} ${GOOGLE_SCOPES.gmailCompose}`,
        extra: {},
      },
    });
    const [connection] = await db
      .insert(connections)
      .values({
        label: "Gmail",
        name: "gmail",
        kind: "gmail",
        capabilities: ["read", "compose"],
        accountId: account.id,
      })
      .returning();
    fixture = {
      botId: bot!.id,
      chatId: chat!.id,
      runId: run!.id,
      connectionId: connection!.id,
      accountId: account.id,
    };
  });

  afterAll(async () => {
    await pool.end();
  });

  async function action(values: Partial<typeof accountActions.$inferInsert> = {}) {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, fixture.connectionId));
    const [row] = await db
      .insert(accountActions)
      .values({
        id: randomUUID(),
        connectionId: fixture.connectionId,
        accountId: fixture.accountId,
        grantRevision: 1,
        connectionRevision: connection!.revision,
        botId: fixture.botId,
        runId: fixture.runId,
        chatId: fixture.chatId,
        itemId: `item-${randomUUID()}`,
        tool: "gmail.send_draft",
        effect: "outward",
        request: { draftId: "d1" },
        summary: "Send “Notes” to Priya",
        labels: { waiting: "Waiting", done: "Sent", failed: "Didn't send" },
        status: "approved",
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        ...values,
      })
      .returning();
    return row!;
  }

  const reload = async (id: string) =>
    (await db.select().from(accountActions).where(eq(accountActions.id, id)))[0]!;

  const followUps = () =>
    db
      .select()
      .from(runs)
      .where(and(eq(runs.chatId, fixture.chatId), eq(runs.trigger, "approval")));

  it("runs an approved action exactly once, even with two workers sweeping at once", async () => {
    const row = await action();
    await Promise.all([sweep(first), sweep(second), sweep(first)]);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    const after = await reload(row.id);
    expect(after.status).toBe("done");
    expect(after.attempt).toBe(1);
    expect(after.reportedAt).not.toBeNull();
    // Done shows in the timeline; it needs no follow-up run.
    expect(await followUps()).toHaveLength(0);
  });

  it("runs an action approved just before a restart, when the worker comes back", async () => {
    const row = await action({ decidedAt: new Date(Date.now() - 60_000) });
    await sweep(
      new AccountActions(ctx, new SessionRegistry(), approvalService, access, integrations),
    );
    expect((await reload(row.id)).status).toBe("done");
  });

  it("never sends again when it can't tell whether a stopped send happened", async () => {
    const row = await action({ status: "executing", nextCheckAt: new Date(Date.now() - 1000) });
    await sweep(first);
    expect(runner.reconcile).toHaveBeenCalledTimes(1);
    expect(runner.execute).not.toHaveBeenCalled();
    const after = await reload(row.id);
    expect(after.status).toBe("unknown");
    const [followUp] = await followUps();
    expect(followUp?.prompt).toMatch(/may or may not have happened/);
    expect(followUp?.parentRunId).toBe(fixture.runId);
  });

  it("runs a stopped action again only when the provider shows it didn't happen", async () => {
    runner.reconcile.mockResolvedValue("not_done");
    const row = await action({ status: "executing", nextCheckAt: new Date(Date.now() - 1000) });
    await sweep(first);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect((await reload(row.id)).status).toBe("done");
  });

  it("checks access again before running a stopped action that didn't happen", async () => {
    runner.reconcile.mockResolvedValue("not_done");
    const row = await action({ status: "executing", nextCheckAt: new Date(Date.now() - 1000) });
    // You turned it off while the worker was down: the lookup may run, the send may not.
    await db
      .update(connections)
      .set({ enabled: false })
      .where(eq(connections.id, fixture.connectionId));
    await sweep(first);
    expect(runner.reconcile).toHaveBeenCalledTimes(1);
    expect(runner.execute).not.toHaveBeenCalled();
    const after = await reload(row.id);
    expect(after.status).toBe("cancelled");
    expect(after.error).toMatch(/turned Gmail off/);
  });

  it("checks access again before retrying a lost answer that didn't go through", async () => {
    runner.execute.mockImplementationOnce(async () => {
      // Access goes while the call is out, and its answer is lost.
      await db
        .update(connections)
        .set({ capabilities: ["read"], revision: 99 })
        .where(eq(connections.id, fixture.connectionId));
      throw new ProviderError("Gmail timed out", null, true);
    });
    runner.reconcile.mockResolvedValue("not_done");
    const row = await action();
    await sweep(first);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect((await reload(row.id)).status).toBe("cancelled");
  });

  it("cancels an action when the account's grant changed since it was asked for", async () => {
    const row = await action();
    await db.update(accounts).set({ grantRevision: 2 }).where(eq(accounts.id, fixture.accountId));
    await sweep(first);
    expect(runner.execute).not.toHaveBeenCalled();
    const after = await reload(row.id);
    expect(after.status).toBe("cancelled");
    expect(after.error).toMatch(/sign-in changed/);
  });

  it("picks an account by its id, and refuses a name two accounts share", async () => {
    const store = new AccountStore(db, key);
    const [client] = await db.select().from(oauthClients);
    const { account: twin } = await store.saveGrant({
      provider: "google",
      externalId: "sub-2",
      oauthClientId: client!.id,
      display: "me@example.com",
      tokens: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3600_000,
        tokenType: "Bearer",
        scope: `openid email ${GOOGLE_SCOPES.gmailRead}`,
        extra: {},
      },
    });
    const [other] = await db
      .insert(connections)
      .values({
        label: "Gmail (me@example.com)",
        name: "gmail_2",
        kind: "gmail",
        capabilities: ["read"],
        accountId: twin.id,
      })
      .returning();
    await expect(access.resolve(fixture.botId, "gmail", "me@example.com")).rejects.toThrow(
      AccountToolError,
    );
    await expect(access.resolve(fixture.botId, "gmail")).rejects.toThrow(/id of one/);
    expect((await access.resolve(fixture.botId, "gmail", other!.id)).connection.id).toBe(other!.id);
    expect((await access.resolve(fixture.botId, "gmail", "GMAIL_2")).connection.id).toBe(other!.id);
    const lines = await access.lines(fixture.botId);
    expect(lines.map((line) => line.account).sort()).toEqual(
      [fixture.connectionId, other!.id].sort(),
    );
  });

  it("leaves a running action alone while its lease lasts", async () => {
    const row = await action({ status: "executing", nextCheckAt: new Date(Date.now() + 60_000) });
    await sweep(first);
    expect(runner.reconcile).not.toHaveBeenCalled();
    expect((await reload(row.id)).status).toBe("executing");
  });

  it("looks before saying a lost answer may have gone through", async () => {
    runner.execute.mockRejectedValue(new ProviderError("Gmail timed out", null, true));
    runner.reconcile.mockResolvedValue(done);
    const row = await action();
    await sweep(first);
    expect(runner.reconcile).toHaveBeenCalledTimes(1);
    expect((await reload(row.id)).status).toBe("done");
  });

  it("fails plainly when the provider clearly refused", async () => {
    runner.execute.mockRejectedValue(new ProviderError("Invalid To header", 400, false));
    const row = await action();
    await sweep(first);
    expect(runner.reconcile).not.toHaveBeenCalled();
    const after = await reload(row.id);
    expect(after.status).toBe("failed");
    expect((await followUps())[0]?.prompt).toMatch(/failed after the user approved it/);
  });

  it("cancels an approved action when the connection was turned off or changed meanwhile", async () => {
    const off = await action();
    await db
      .update(connections)
      .set({ enabled: false })
      .where(eq(connections.id, fixture.connectionId));
    await sweep(first);
    expect(runner.execute).not.toHaveBeenCalled();
    expect(await reload(off.id)).toMatchObject({ status: "cancelled" });
    expect((await reload(off.id)).error).toMatch(/turned Gmail off/);

    await db
      .update(connections)
      .set({ enabled: true, revision: 99 })
      .where(eq(connections.id, fixture.connectionId));
    const changed = await action({ connectionRevision: 1 });
    await sweep(first);
    expect(runner.execute).not.toHaveBeenCalled();
    expect((await reload(changed.id)).error).toMatch(/changed Gmail's settings/);
  });

  it("cancels an action the teammate lost access to, or the account no longer allows", async () => {
    const other = randomUUID();
    await db
      .update(connections)
      .set({ botIds: [other] })
      .where(eq(connections.id, fixture.connectionId));
    const noAccess = await action();
    await sweep(first);
    expect((await reload(noAccess.id)).error).toMatch(/no longer has Gmail/);

    await db
      .update(connections)
      .set({ botIds: null, capabilities: ["read"] })
      .where(eq(connections.id, fixture.connectionId));
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, fixture.connectionId));
    const noCompose = await action({ connectionRevision: connection!.revision });
    await sweep(first);
    expect((await reload(noCompose.id)).error).toMatch(/no longer allows this/);
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("expires an action not approved in time, and closes its approval", async () => {
    const [approval] = await db
      .insert(approvals)
      .values({
        runId: fixture.runId,
        botId: fixture.botId,
        chatId: fixture.chatId,
        kind: "account_outward",
        title: "Send “Notes” to Priya",
        itemId: "approval-item",
      })
      .returning();
    const row = await action({
      status: "pending",
      decidedAt: null,
      approvalId: approval!.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    const decided = vi.fn();
    ctx.events.on("approvalDecided", decided);
    await sweep(first);
    ctx.events.off("approvalDecided", decided);
    expect((await reload(row.id)).status).toBe("expired");
    const [closed] = await db.select().from(approvals).where(eq(approvals.id, approval!.id));
    expect(closed?.status).toBe("expired");
    expect(decided).toHaveBeenCalledWith(approval!.id);
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("reports each outcome once, however many sweeps see it", async () => {
    runner.execute.mockResolvedValue({ status: "failed", error: "No such draft" });
    await action();
    await Promise.all([sweep(first), sweep(second)]);
    await Promise.all([sweep(first), sweep(second)]);
    expect(await followUps()).toHaveLength(1);
  });
});
