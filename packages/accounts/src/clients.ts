import { accounts, oauthClients, type Db } from "@open-bot/db";
import type { AccountProvider } from "@open-bot/shared";
import { decryptSecret, encryptSecret } from "@open-bot/shared/secrets";
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";

type Row = typeof oauthClients.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** An OAuth client accounts sign in through, with its secret. */
export interface OAuthClient {
  /** Ours: what accounts reference. */
  id: string;
  provider: AccountProvider;
  /** The provider's. */
  clientId: string;
  clientSecret: string | null;
  /** What Settings shows of it, without the secret. */
  hint: string | null;
  issuer: string | null;
  redirectUri: string | null;
}

/**
 * The OAuth clients of every provider. Each provider has one current client, which new sign-ins
 * use. Replacing it retires the old one rather than deleting it: a grant can only be refreshed by
 * the client it was made to, so a retired client stays until no account uses it.
 */
export class OAuthClients {
  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
  ) {}

  private open(row: Row): OAuthClient {
    return {
      id: row.id,
      provider: row.provider,
      clientId: row.clientId,
      clientSecret: row.encryptedSecret
        ? decryptSecret(row.encryptedSecret, this.encryptionKey)
        : null,
      hint: row.hint,
      issuer: row.issuer,
      redirectUri: row.redirectUri,
    };
  }

  /** The client a grant belongs to, retired or not. */
  async byId(id: string): Promise<OAuthClient | null> {
    const [row] = await this.db.select().from(oauthClients).where(eq(oauthClients.id, id));
    return row ? this.open(row) : null;
  }

  /** The client new sign-ins at this provider use, if there is one. */
  async current(provider: AccountProvider): Promise<OAuthClient | null> {
    const [row] = await this.db
      .select()
      .from(oauthClients)
      .where(and(eq(oauthClients.provider, provider), isNull(oauthClients.retiredAt)));
    return row ? this.open(row) : null;
  }

  /**
   * Make this the provider's current client. The same client again (by its id) is updated in place,
   * so pasting a rotated secret keeps its grants; any other current client is retired.
   */
  async makeCurrent(input: {
    provider: AccountProvider;
    source: "owner" | "registered";
    clientId: string;
    clientSecret: string | null;
    hint: string | null;
    issuer?: string;
    redirectUri?: string;
  }): Promise<OAuthClient> {
    return this.db.transaction(async (tx) => {
      // One sign-in setup at a time per provider: the current-client index allows only one.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`oauth_clients:${input.provider}`}))`,
      );
      const values = {
        clientId: input.clientId,
        encryptedSecret: input.clientSecret
          ? encryptSecret(input.clientSecret, this.encryptionKey)
          : null,
        hint: input.hint,
        source: input.source,
        issuer: input.issuer ?? null,
        redirectUri: input.redirectUri ?? null,
      };
      await tx
        .update(oauthClients)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(oauthClients.provider, input.provider),
            isNull(oauthClients.retiredAt),
            sql`${oauthClients.clientId} <> ${input.clientId}`,
          ),
        );
      const [row] = await tx
        .insert(oauthClients)
        .values({ provider: input.provider, ...values })
        .onConflictDoUpdate({
          target: [oauthClients.provider, oauthClients.clientId],
          set: { ...values, retiredAt: null },
        })
        .returning();
      await this.forgetUnused(tx, input.provider);
      return this.open(row!);
    });
  }

  /** Retired clients no grant belongs to any more are of no use. */
  private async forgetUnused(tx: Tx | Db, provider: AccountProvider): Promise<void> {
    await tx
      .delete(oauthClients)
      .where(
        and(
          eq(oauthClients.provider, provider),
          isNotNull(oauthClients.retiredAt),
          notExists(
            tx
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.oauthClientId, oauthClients.id)),
          ),
        ),
      );
  }

  /** After an account is gone: its client may be the last thing keeping a retired one. */
  async tidy(provider: AccountProvider): Promise<void> {
    await this.forgetUnused(this.db, provider);
  }
}
