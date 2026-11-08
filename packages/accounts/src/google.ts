import { secretHint } from "@open-bot/domain/server";
import { googleEndpoints } from "./endpoints";
import { OAuthError, revokeToken, tokenRequest } from "./oauth";
import type { ProviderAdapter } from "./provider";

/**
 * Google: your own OAuth client (a Web application client in your Google Cloud project), which
 * you paste into Settings. A single owner never needs Google's app verification this way.
 */
export const google: ProviderAdapter = {
  id: "google",
  refreshTokens: "required",
  scopesOnRefresh: true,
  // Google's grants last until revoked; only a grant to a new client starts again.
  signInRenewsGrant: false,
  noLastingAccess:
    "Google didn't give open-bot lasting access. Remove open-bot under Third-party access in your Google Account, then connect again.",

  invalidOwnerClient(client) {
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.clientId.trim()))
      return "That isn't a Google OAuth client ID. It ends in .apps.googleusercontent.com.";
    if (client.clientSecret.trim().length < 10) return "Paste the client secret too.";
    return null;
  },

  ownerClientHint(client) {
    return `${client.clientId.slice(0, 12)}… · ${secretHint(client.clientSecret)}`;
  },

  async signInClient(clients) {
    const client = await clients.current("google");
    if (!client) throw new OAuthError("Add your Google OAuth client first (Set up Google).");
    return client;
  },

  async authorizationUrl({ client, redirectUri, scopes, state, challenge, account }) {
    // A brand new grant (or one to another client) needs consent, so Google issues a refresh token.
    const consent =
      !account || account.oauthClientId !== client.id || account.status !== "connected";
    const url = new URL(googleEndpoints().authorize);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "true",
      ...(consent ? { prompt: "consent" } : {}),
      // Sign in as the account being reconnected.
      ...(account ? { login_hint: account.display } : {}),
    }).toString();
    return url.toString();
  },

  exchange(client, code, verifier, redirectUri) {
    return tokenRequest(googleEndpoints().token, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret ?? "",
    });
  },

  async identity(tokens) {
    const response = await fetch(googleEndpoints().userinfo, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as { sub?: string; email?: string };
    if (!response.ok || !body.sub)
      throw new OAuthError(`Google didn't say who signed in (${response.status}).`);
    return { externalId: body.sub, display: body.email ?? body.sub };
  },

  refresh(client, refreshToken) {
    return tokenRequest(googleEndpoints().token, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret ?? "",
    });
  },

  // Revoking removes the whole grant: every scope, for Gmail and Calendar both.
  revoke(_client, token) {
    return revokeToken(googleEndpoints().revoke, token);
  },
};
