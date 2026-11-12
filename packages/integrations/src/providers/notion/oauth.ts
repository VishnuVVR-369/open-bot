import type { OAuthClient } from "../../core/clients";
import { notionMcpUrl } from "../../core/endpoints";
import { OAuthError, revokeToken, tokenRequest } from "../../core/oauth";
import type { ProviderAdapter } from "../../core/provider";

/**
 * Notion: its hosted MCP server, with OAuth 2.0, PKCE and dynamic client registration. This app
 * registers itself once per redirect URI and keeps the client: registering again would orphan the
 * grants made to the old one, so an old client is only retired.
 */

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string | null;
  /** The resource the tokens are for (RFC 8707). */
  resource: string;
}

let cached: { url: string; server: AuthorizationServer; at: number } | null = null;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new OAuthError(`Notion's sign-in metadata answered ${response.status}.`);
  return (await response.json()) as Record<string, unknown>;
}

/** Find Notion's authorization server: protected resource metadata (RFC 9728), then RFC 8414. */
export async function notionAuthorizationServer(): Promise<AuthorizationServer> {
  const mcpUrl = notionMcpUrl();
  if (cached && cached.url === mcpUrl && Date.now() - cached.at < 60 * 60_000) return cached.server;
  const mcp = new URL(mcpUrl);
  const resourceMetadata = await getJson(
    `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
  ).catch(() => getJson(`${mcp.origin}/.well-known/oauth-protected-resource`));
  const issuer = (resourceMetadata.authorization_servers as string[] | undefined)?.[0];
  if (!issuer) throw new OAuthError("Notion didn't name its sign-in server.");
  const metadata = await getJson(
    `${new URL(issuer).origin}/.well-known/oauth-authorization-server`,
  );
  const required = ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const;
  for (const key of required)
    if (typeof metadata[key] !== "string") throw new OAuthError(`Notion's sign-in has no ${key}.`);
  const server: AuthorizationServer = {
    issuer: typeof metadata.issuer === "string" ? metadata.issuer : issuer,
    authorizationEndpoint: metadata.authorization_endpoint as string,
    tokenEndpoint: metadata.token_endpoint as string,
    registrationEndpoint: metadata.registration_endpoint as string,
    revocationEndpoint:
      typeof metadata.revocation_endpoint === "string" ? metadata.revocation_endpoint : null,
    resource: typeof resourceMetadata.resource === "string" ? resourceMetadata.resource : mcpUrl,
  };
  cached = { url: mcpUrl, server, at: Date.now() };
  return server;
}

/** Register open-bot with Notion's authorization server for this redirect URI (RFC 7591). */
async function register(
  server: AuthorizationServer,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const response = await fetch(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "open-bot",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    client_id?: string;
    client_secret?: string;
    error_description?: string;
  };
  if (!response.ok || !body.client_id)
    throw new OAuthError(
      `Notion didn't register open-bot: ${body.error_description ?? response.status}.`,
    );
  return { clientId: body.client_id, clientSecret: body.client_secret ?? null };
}

function clientForm(client: OAuthClient): Record<string, string> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  };
}

function field(extra: Record<string, unknown>, key: string): string | null {
  const value = extra[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const notion: ProviderAdapter = {
  id: "notion",
  refreshTokens: "required",
  // Notion doesn't report scopes: what you can see in the workspace is the grant.
  scopesOnRefresh: false,
  // Its grants last 180 days from each authorization.
  signInRenewsGrant: true,
  noLastingAccess: "Notion didn't give open-bot lasting access. Connect again.",

  async signInClient(clients, redirectUri) {
    const server = await notionAuthorizationServer();
    const current = await clients.current("notion");
    if (current && current.issuer === server.issuer && current.redirectUri === redirectUri)
      return current;
    // First sign-in, or the app moved (a new redirect URI) or Notion's sign-in server did.
    const registered = await register(server, redirectUri);
    return clients.makeCurrent({
      provider: "notion",
      source: "registered",
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
      hint: null,
      issuer: server.issuer,
      redirectUri,
    });
  },

  async authorizationUrl({ client, redirectUri, state, challenge }) {
    const server = await notionAuthorizationServer();
    const url = new URL(server.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: server.resource,
    }).toString();
    return url.toString();
  },

  async exchange(client, code, verifier, redirectUri) {
    const server = await notionAuthorizationServer();
    return tokenRequest(server.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: server.resource,
      ...clientForm(client),
    });
  },

  /** From the code exchange: Notion says who connected only then. */
  async identity(tokens) {
    const workspaceId = field(tokens.extra, "workspace_id");
    const userId = field(tokens.extra, "user_id");
    const externalId =
      workspaceId && userId ? `${workspaceId}:${userId}` : field(tokens.extra, "bot_id"); // vocabulary: allow (Notion's field)
    if (!externalId) throw new OAuthError("Notion didn't say which workspace you connected.");
    return { externalId, display: field(tokens.extra, "workspace_name") ?? "Notion" };
  },

  /** Every refresh rotates the refresh token; the store keeps the new one before it's used. */
  async refresh(client, refreshToken) {
    const server = await notionAuthorizationServer();
    return tokenRequest(server.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: server.resource,
      ...clientForm(client),
    });
  },

  async revoke(client, token) {
    const server = await notionAuthorizationServer();
    if (!server.revocationEndpoint) return;
    await revokeToken(server.revocationEndpoint, token, clientForm(client));
  },
};
