import type { AccountProvider, AccountStatus } from "@open-bot/domain";
import type { OAuthClient, OAuthClients } from "./clients";
import type { TokenResponse } from "./oauth";

/** The account a sign-in is for, when it reconnects or widens one you have. */
export interface SignInAccount {
  display: string;
  oauthClientId: string;
  status: AccountStatus;
}

/**
 * How one auth provider signs you in and keeps the grant working. Everything provider-specific
 * about credentials lives behind this; the store, the web app's sign-in and the worker only talk
 * to it. Its public description (labels, scopes, lifetimes) is `AUTH_PROVIDERS` in shared.
 */
export interface ProviderAdapter {
  readonly id: AccountProvider;
  /**
   * Whether a grant must come with a refresh token. "optional" accepts an access token alone, which
   * works until it expires (never, for a token without an expiry).
   */
  readonly refreshTokens: "required" | "optional";
  /** A refresh's answer says the grant's scopes, which replace the stored ones. */
  readonly scopesOnRefresh: boolean;
  /** Every sign-in starts the grant's lifetime again, not only a grant to a new client. */
  readonly signInRenewsGrant: boolean;
  /** Said when the provider didn't give lasting access, and a refresh token is required. */
  readonly noLastingAccess: string;

  /** For providers whose client you paste in: why it can't be right, or null. */
  invalidOwnerClient?(client: { clientId: string; clientSecret: string }): string | null;
  /** For providers whose client you paste in: what Settings shows of it. */
  ownerClientHint?(client: { clientId: string; clientSecret: string }): string;

  /**
   * The client a new sign-in uses: the current one, or one registered now for this redirect URI
   * when the provider allows it. Throws an OAuthError, said for you, when it needs setting up.
   */
  signInClient(clients: OAuthClients, redirectUri: string): Promise<OAuthClient>;
  /** The provider's sign-in page to send you to. */
  authorizationUrl(input: {
    client: OAuthClient;
    redirectUri: string;
    scopes: string[];
    state: string;
    challenge: string;
    account: SignInAccount | null;
  }): Promise<string>;
  exchange(
    client: OAuthClient,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<TokenResponse>;
  /** Who signed in: a stable id at the provider, and what Settings shows. */
  identity(tokens: TokenResponse): Promise<{ externalId: string; display: string }>;
  refresh(client: OAuthClient, refreshToken: string): Promise<TokenResponse>;
  /** Revoke the grant. Best effort: a token already gone is fine. */
  revoke(client: OAuthClient, token: string): Promise<void>;
}
