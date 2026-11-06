import { accounts, connections, type AccountTokens, type Db } from "@open-bot/db";
import { authProvider, parseScopes, type AccountProvider } from "@open-bot/shared";
import { decryptSecret, encryptSecret } from "@open-bot/shared/secrets";
import { and, eq, sql } from "drizzle-orm";
import { OAuthClients } from "./clients";
import { OAuthError, type TokenResponse } from "./oauth";
import { providerAdapter } from "./providers";

type Account = typeof accounts.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** An access token this close to expiring is refreshed first. */
const REFRESH_MARGIN_MS = 2 * 60_000;

/** The account can't be used until you sign in again (or it's gone). */
export class AccountUnavailableError extends Error {
  constructor(
    readonly accountId: string,
    readonly reason: "needs_reconnect" | "revoked" | "missing",
    message: string,
  ) {
    super(message);
  }
}

/** Signed in as someone other than the account being reconnected. */
export class AccountIdentityError extends Error {}

/**
 * Your accounts' tokens, encrypted in Postgres. Every change to them (a refresh, a new sign-in,
 * more scopes) goes through one locked path, so a rotated refresh token is never lost to a race:
 * a provider that rotates refresh tokens (Notion) revokes the whole grant when an old one is used
 * again. What differs between providers is their adapter's business; this is the same for all.
 */
export class AccountStore {
  readonly clients: OAuthClients;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
  ) {
    this.clients = new OAuthClients(db, encryptionKey);
  }

  tokens(row: Pick<Account, "encrypted">): AccountTokens {
    return JSON.parse(decryptSecret(row.encrypted, this.encryptionKey)) as AccountTokens;
  }

  private seal(tokens: AccountTokens): string {
    return encryptSecret(JSON.stringify(tokens), this.encryptionKey);
  }

  /** Run `fn` holding the account's row lock, so nothing else changes its tokens meanwhile. */
  async withAccountLock<T>(
    accountId: string,
    fn: (tx: Tx, row: Account) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .for("update");
      if (!row) throw new AccountUnavailableError(accountId, "missing", "That account is gone.");
      return fn(tx, row);
    });
  }

  /**
   * A working access token for the account, refreshed when it's about to expire. Concurrent
   * callers in this process share one refresh; the row lock covers other processes.
   */
  async accessToken(accountId: string): Promise<string> {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!row) throw new AccountUnavailableError(accountId, "missing", "That account is gone.");
    this.ensureUsable(row);
    const tokens = this.tokens(row);
    if (fresh(tokens)) return tokens.accessToken;
    return this.refresh(accountId, false);
  }

  /** Refresh now, even if the token is still good: keeps grants that end when idle alive. */
  refreshNow(accountId: string): Promise<string> {
    return this.refresh(accountId, true);
  }

  private refresh(accountId: string, force: boolean): Promise<string> {
    const running = this.inflight.get(accountId);
    if (running) return running;
    const work = this.refreshLocked(accountId, force).finally(() =>
      this.inflight.delete(accountId),
    );
    this.inflight.set(accountId, work);
    return work;
  }

  private ensureUsable(row: Account): void {
    const provider = authProvider(row.provider).label;
    if (row.status === "revoked")
      throw new AccountUnavailableError(row.id, "revoked", `${provider} was disconnected.`);
    if (row.status === "needs_reconnect")
      throw new AccountUnavailableError(
        row.id,
        "needs_reconnect",
        `${provider} needs reconnecting: ${row.lastError ?? "its sign-in stopped working"}.`,
      );
  }

  private async refreshLocked(accountId: string, force: boolean): Promise<string> {
    // A lost grant is recorded and committed first, then reported; throwing inside the
    // transaction would roll the record back.
    let lost: { reason: string; provider: AccountProvider } | null = null;
    const token = await this.withAccountLock(accountId, async (tx, row) => {
      this.ensureUsable(row);
      const tokens = this.tokens(row);
      // Another refresh may have finished while this one waited for the lock.
      if (!force && fresh(tokens)) return tokens.accessToken;
      const adapter = providerAdapter(row.provider);
      const loseGrant = async (reason: string) => {
        lost = { reason, provider: row.provider };
        await tx
          .update(accounts)
          .set({ status: "needs_reconnect", lastError: reason })
          .where(eq(accounts.id, row.id));
        return null;
      };
      if (!tokens.refreshToken)
        // Nothing to refresh with: the access token is all there is, while it lasts.
        return fresh(tokens) ? tokens.accessToken : loseGrant("its access expired");
      const client = await this.clients.byId(row.oauthClientId);
      if (!client) return loseGrant("the sign-in client it was made with is gone");
      let next: TokenResponse;
      try {
        next = await adapter.refresh(client, tokens.refreshToken);
      } catch (error) {
        if (error instanceof OAuthError && error.grantLost)
          return loseGrant(`${authProvider(row.provider).label} ended the sign-in (${error.code})`);
        throw error;
      }
      const merged: AccountTokens = {
        accessToken: next.accessToken,
        // Some providers keep the refresh token and don't send it again; others rotate it.
        refreshToken: next.refreshToken ?? tokens.refreshToken,
        expiresAt: next.expiresAt,
        tokenType: next.tokenType,
      };
      const scopes =
        adapter.scopesOnRefresh && next.scope ? parseScopes(row.provider, next.scope) : null;
      await tx
        .update(accounts)
        .set({
          encrypted: this.seal(merged),
          credentialVersion: sql`${accounts.credentialVersion} + 1`,
          lastRefreshedAt: new Date(),
          ...(scopes ? { scopes } : {}),
          ...(scopes && lostScope(row.scopes, scopes)
            ? { grantRevision: sql`${accounts.grantRevision} + 1` }
            : {}),
        })
        .where(eq(accounts.id, row.id));
      return merged.accessToken;
    });
    if (lost) {
      const { reason, provider } = lost as { reason: string; provider: AccountProvider };
      throw new AccountUnavailableError(
        accountId,
        "needs_reconnect",
        `${authProvider(provider).label} needs reconnecting: ${reason}.`,
      );
    }
    return token!;
  }

  /**
   * Store what a sign-in granted: a new account, or new tokens and scopes for an existing one.
   * Under the same lock as refreshes. A missing refresh token keeps the one already stored, when
   * it was made to the same client. `grantChanged` says the grant lost something approvals may
   * rely on (a scope, or its client), so pending actions on it should be cancelled.
   */
  async saveGrant(input: {
    provider: AccountProvider;
    externalId: string;
    oauthClientId: string;
    display: string;
    tokens: TokenResponse;
    /** Reconnecting this account: signing in as anyone else is refused. */
    expectedAccountId?: string;
  }): Promise<{ account: Account; created: boolean; grantChanged: boolean }> {
    const adapter = providerAdapter(input.provider);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(accounts)
            .where(
              and(eq(accounts.provider, input.provider), eq(accounts.externalId, input.externalId)),
            )
            .for("update");
          if (input.expectedAccountId && existing?.id !== input.expectedAccountId)
            throw new AccountIdentityError(
              "You signed in as a different account than the one this connection uses.",
            );
          const previous = existing ? this.tokens(existing) : null;
          const sameClient = existing?.oauthClientId === input.oauthClientId;
          const refreshToken =
            input.tokens.refreshToken ?? (sameClient ? (previous?.refreshToken ?? null) : null);
          if (!refreshToken && adapter.refreshTokens === "required")
            throw new OAuthError(adapter.noLastingAccess);
          const encrypted = this.seal({
            accessToken: input.tokens.accessToken,
            refreshToken,
            expiresAt: input.tokens.expiresAt,
            tokenType: input.tokens.tokenType,
          });
          const scopes = input.tokens.scope
            ? parseScopes(input.provider, input.tokens.scope)
            : (existing?.scopes ?? []);
          if (existing) {
            const grantChanged = !sameClient || lostScope(existing.scopes, scopes);
            const [account] = await tx
              .update(accounts)
              .set({
                oauthClientId: input.oauthClientId,
                display: input.display,
                scopes,
                encrypted,
                credentialVersion: sql`${accounts.credentialVersion} + 1`,
                ...(grantChanged ? { grantRevision: sql`${accounts.grantRevision} + 1` } : {}),
                status: "connected",
                lastError: null,
                notifiedAt: null,
                lastRefreshedAt: new Date(),
                ...(adapter.signInRenewsGrant || !sameClient ? { grantedAt: new Date() } : {}),
              })
              .where(eq(accounts.id, existing.id))
              .returning();
            return { account: account!, created: false, grantChanged };
          }
          const [account] = await tx
            .insert(accounts)
            .values({
              provider: input.provider,
              externalId: input.externalId,
              oauthClientId: input.oauthClientId,
              display: input.display,
              scopes,
              encrypted,
              lastRefreshedAt: new Date(),
            })
            .returning();
          return { account: account!, created: true, grantChanged: false };
        });
      } catch (error) {
        // Two sign-ins for a new account raced; the second one updates the first's row.
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  /** Record that the account was used, for Settings and for keeping idle grants alive. */
  async touch(accountId: string): Promise<void> {
    await this.db
      .update(accounts)
      .set({ lastUsedAt: new Date() })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Revoke the grant at the provider and forget the account. Only when no connection uses it:
   * revoking ends every integration the sign-in serves (Gmail and Calendar together). Returns a
   * warning when the provider couldn't be reached, after forgetting the tokens anyway.
   */
  async revoke(accountId: string): Promise<{ warning: string | null }> {
    let warning: string | null = null;
    let provider: AccountProvider | null = null;
    await this.withAccountLock(accountId, async (tx, row) => {
      const [used] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.accountId, row.id))
        .limit(1);
      if (used)
        throw new AccountUnavailableError(
          row.id,
          "revoked",
          "A connection still uses this account. Remove it first.",
        );
      provider = row.provider;
      const tokens = this.tokens(row);
      const definition = authProvider(row.provider);
      try {
        const client = await this.clients.byId(row.oauthClientId);
        if (client)
          await providerAdapter(row.provider).revoke(
            client,
            tokens.refreshToken ?? tokens.accessToken,
          );
      } catch {
        warning = `${definition.label} couldn't be reached to revoke access. ${definition.revokeHint}`;
      }
      await tx.delete(accounts).where(eq(accounts.id, row.id));
    });
    if (provider) await this.clients.tidy(provider);
    return { warning };
  }
}

function fresh(tokens: AccountTokens): boolean {
  return tokens.expiresAt === null || tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

/** The grant no longer has a scope it had. */
function lostScope(before: readonly string[], after: readonly string[]): boolean {
  return before.some((scope) => !after.includes(scope));
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string }; code?: string }) ?? {};
  return cause.code === "23505" || cause.cause?.code === "23505";
}
