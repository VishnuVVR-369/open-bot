import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { accounts, oauthClients } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import type { OAuthClient } from "./clients";
import type { TokenResponse } from "./oauth";
import { AccountIdentityError, AccountStore, AccountUnavailableError } from "./store";

const url = testDatabaseServer();

/** What the stand-in token endpoint answers, and what it was asked. */
interface TokenEndpoint {
  answer: (form: URLSearchParams) => { status: number; body: Record<string, unknown> };
  requests: URLSearchParams[];
  /** Holds each answer this long, so concurrent refreshes really overlap. */
  delayMs: number;
}

describe.skipIf(!url)("account tokens with Postgres", () => {
  const database = testDatabase(url);
  const { db } = database;
  const key = randomBytes(32).toString("base64");
  const client = {
    clientId: "test-client.apps.googleusercontent.com",
    clientSecret: "secret-1234567",
  };
  const endpoint: TokenEndpoint = {
    answer: () => ({ status: 500, body: {} }),
    requests: [],
    delayMs: 0,
  };
  let server: Server;
  let current: OAuthClient;

  const grant = (overrides: Partial<TokenResponse> = {}): TokenResponse => ({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    extra: {},
    ...overrides,
  });

  const saveAccount = async (store: AccountStore, tokens = grant()) =>
    (
      await store.saveGrant({
        provider: "google",
        externalId: "sub-1",
        oauthClientId: current.id,
        display: "me@example.com",
        tokens,
      })
    ).account;

  beforeAll(async () => {
    await database.create();
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        endpoint.requests.push(form);
        const { status, body: answer } = endpoint.answer(form);
        setTimeout(() => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(answer));
        }, endpoint.delayMs);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GOOGLE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await db.delete(accounts);
    await db.delete(oauthClients);
    current = await new AccountStore(db, key).clients.makeCurrent({
      provider: "google",
      source: "owner",
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      hint: "test",
    });
    endpoint.requests = [];
    endpoint.delayMs = 0;
  });

  afterAll(async () => {
    delete process.env.GOOGLE_BASE_URL;
    await new Promise((resolve) => server?.close(resolve));
    await database.drop();
  });

  it("uses a fresh token without asking Google", async () => {
    const store = new AccountStore(db, key);
    const account = await saveAccount(store);
    expect(await store.accessToken(account.id)).toBe("access-1");
    expect(endpoint.requests).toHaveLength(0);
  });

  it("refreshes once for many callers, in one process and across processes", async () => {
    let issued = 0;
    endpoint.delayMs = 150;
    endpoint.answer = () => ({
      status: 200,
      body: { access_token: `access-new-${++issued}`, expires_in: 3600, token_type: "Bearer" },
    });
    const first = new AccountStore(db, key);
    // Another worker process, with its own memory: only the row lock keeps it from refreshing too.
    const second = new AccountStore(db, key);
    const account = await saveAccount(first, grant({ expiresAt: Date.now() - 1000 }));
    const tokens = await Promise.all([
      first.accessToken(account.id),
      first.accessToken(account.id),
      second.accessToken(account.id),
      second.accessToken(account.id),
    ]);
    expect(endpoint.requests).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set(["access-new-1"]));
  });

  it("keeps the stored refresh token when Google doesn't send a new one", async () => {
    endpoint.answer = () => ({
      status: 200,
      body: { access_token: "access-2", expires_in: 3600 },
    });
    const store = new AccountStore(db, key);
    const account = await saveAccount(store, grant({ expiresAt: Date.now() - 1000 }));
    expect(await store.accessToken(account.id)).toBe("access-2");
    const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(store.tokens(row!).refreshToken).toBe("refresh-1");
    expect(endpoint.requests[0]?.get("refresh_token")).toBe("refresh-1");
  });

  it("commits a rotated refresh token, and uses it next time", async () => {
    let round = 0;
    endpoint.answer = () => {
      round += 1;
      return {
        status: 200,
        body: {
          access_token: `access-r${round}`,
          refresh_token: `refresh-r${round}`,
          expires_in: 1,
        },
      };
    };
    const store = new AccountStore(db, key);
    const account = await saveAccount(store, grant({ expiresAt: Date.now() - 1000 }));
    await store.refreshNow(account.id);
    await store.refreshNow(account.id);
    expect(endpoint.requests.map((form) => form.get("refresh_token"))).toEqual([
      "refresh-1",
      "refresh-r1",
    ]);
  });

  it("marks the account for reconnecting when Google ends the grant, and stops asking", async () => {
    endpoint.answer = () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    });
    const store = new AccountStore(db, key);
    const account = await saveAccount(store, grant({ expiresAt: Date.now() - 1000 }));
    await expect(store.accessToken(account.id)).rejects.toBeInstanceOf(AccountUnavailableError);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row?.status).toBe("needs_reconnect");
    expect(row?.lastError).toMatch(/invalid_grant/);
    await expect(store.accessToken(account.id)).rejects.toThrow(/needs reconnecting/);
    expect(endpoint.requests).toHaveLength(1);
  });

  it("doesn't lose the account to a network failure", async () => {
    endpoint.answer = () => ({ status: 503, body: {} });
    const store = new AccountStore(db, key);
    const account = await saveAccount(store, grant({ expiresAt: Date.now() - 1000 }));
    await expect(store.accessToken(account.id)).rejects.not.toBeInstanceOf(AccountUnavailableError);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row?.status).toBe("connected");
  });

  it("keeps the refresh token across a sign-in that didn't send one, and refuses the wrong person", async () => {
    const store = new AccountStore(db, key);
    const account = await saveAccount(store);
    const again = await store.saveGrant({
      provider: "google",
      externalId: "sub-1",
      oauthClientId: current.id,
      display: "me@example.com",
      tokens: grant({
        accessToken: "access-3",
        refreshToken: null,
        scope: "openid email https://www.googleapis.com/auth/gmail.modify",
      }),
      expectedAccountId: account.id,
    });
    expect(again.created).toBe(false);
    expect(store.tokens(again.account).refreshToken).toBe("refresh-1");
    expect(again.account.scopes).toContain("https://www.googleapis.com/auth/gmail.modify");
    await expect(
      store.saveGrant({
        provider: "google",
        externalId: "sub-2",
        oauthClientId: current.id,
        display: "someone@example.com",
        tokens: grant(),
        expectedAccountId: account.id,
      }),
    ).rejects.toBeInstanceOf(AccountIdentityError);
  });

  it("says when a sign-in lost something, and not when it only added", async () => {
    const store = new AccountStore(db, key);
    const account = await saveAccount(store);
    const signIn = (scope: string) =>
      store.saveGrant({
        provider: "google",
        externalId: "sub-1",
        oauthClientId: current.id,
        display: "me@example.com",
        tokens: grant({ scope }),
      });
    const same = await signIn("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(same.grantChanged).toBe(false);
    const wider = await signIn(
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    );
    expect(wider.grantChanged).toBe(false);
    expect(wider.account.grantRevision).toBe(account.grantRevision);
    const narrower = await signIn("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(narrower.grantChanged).toBe(true);
    expect(narrower.account.grantRevision).toBe(account.grantRevision + 1);
  });

  it("keeps refreshing a grant with its own client after the client is replaced", async () => {
    endpoint.answer = () => ({
      status: 200,
      body: { access_token: "access-old-client", expires_in: 3600 },
    });
    const store = new AccountStore(db, key);
    const account = await saveAccount(store, grant({ expiresAt: Date.now() - 1000 }));
    const replacement = await store.clients.makeCurrent({
      provider: "google",
      source: "owner",
      clientId: "other-client.apps.googleusercontent.com",
      clientSecret: "secret-7654321",
      hint: "other",
    });
    expect((await store.clients.current("google"))?.id).toBe(replacement.id);
    expect(await store.accessToken(account.id)).toBe("access-old-client");
    expect(endpoint.requests[0]?.get("client_id")).toBe(client.clientId);
    // The old client goes once no grant belongs to it.
    expect(await store.clients.byId(current.id)).not.toBeNull();
    await store.revoke(account.id).catch(() => undefined);
    expect(await store.clients.byId(current.id)).toBeNull();
    expect(await store.clients.byId(replacement.id)).not.toBeNull();
  });

  it("updates the same client in place, so a new secret keeps its grants", async () => {
    const store = new AccountStore(db, key);
    const account = await saveAccount(store);
    const again = await store.clients.makeCurrent({
      provider: "google",
      source: "owner",
      clientId: client.clientId,
      clientSecret: "rotated-secret-123",
      hint: "rotated",
    });
    expect(again.id).toBe(current.id);
    expect(again.clientSecret).toBe("rotated-secret-123");
    const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row?.oauthClientId).toBe(current.id);
  });

  it("waits for a client setup that a web app from before the lock helper holds", async () => {
    // That release locked `hashtext('oauth_clients:<provider>')`; both must still exclude each other.
    const before = await database.pool.connect();
    try {
      await before.query("begin");
      await before.query("select pg_advisory_xact_lock(hashtext('oauth_clients:google'))");
      const setup = new AccountStore(db, key).clients.makeCurrent({
        provider: "google",
        source: "owner",
        clientId: "other-client.apps.googleusercontent.com",
        clientSecret: "secret-7654321",
        hint: "other",
      });
      for (;;) {
        const { rows } = await before.query<{ waiting: number }>(
          "select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted",
        );
        if (rows[0]!.waiting === 1) break;
      }
      await before.query("commit");
      expect((await setup).clientId).toBe("other-client.apps.googleusercontent.com");
    } finally {
      before.release();
    }
  });

  it("makes one account when two sign-ins race", async () => {
    const store = new AccountStore(db, key);
    const results = await Promise.all([saveAccount(store), saveAccount(store)]);
    expect(new Set(results.map((account) => account.id)).size).toBe(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
  });
});
