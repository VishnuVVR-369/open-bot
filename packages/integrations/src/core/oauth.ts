import { createHash, randomBytes } from "node:crypto";

/** OAuth 2.0 with PKCE, as both providers speak it. */

export class OAuthError extends Error {
  constructor(
    message: string,
    /** The provider's error code, like `invalid_grant`. */
    readonly code: string | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
  }

  /** The grant is gone (revoked, expired, rotated away): only signing in again helps. */
  get grantLost(): boolean {
    return this.code === "invalid_grant" || this.code === "unauthorized_client";
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, or null when the provider didn't say. */
  expiresAt: number | null;
  tokenType: string;
  /** Space-separated, as the provider sent it. */
  scope: string | null;
  /** Everything else the provider sent (Notion's workspace and user ids). */
  extra: Record<string, unknown>;
}

const TIMEOUT_MS = 20_000;

/** POST a form to a token endpoint and read the token response, or throw a readable OAuthError. */
export async function tokenRequest(
  url: string,
  form: Record<string, string>,
  basicAuth?: { clientId: string; clientSecret: string },
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": "open-bot",
  };
  if (basicAuth)
    headers.authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(basicAuth.clientId)}:${encodeURIComponent(basicAuth.clientSecret)}`,
    ).toString("base64")}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthError(
      `Couldn't reach the sign-in service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : null;
    const description = typeof body.error_description === "string" ? body.error_description : null;
    throw new OAuthError(
      description ?? code ?? `The sign-in service answered ${response.status}.`,
      code,
      response.status,
    );
  }
  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    token_type: tokenType,
    scope,
    ...extra
  } = body;
  return {
    accessToken: accessToken as string,
    refreshToken: typeof refreshToken === "string" && refreshToken ? refreshToken : null,
    expiresAt:
      typeof expiresIn === "number" || typeof expiresIn === "string"
        ? Date.now() + Number(expiresIn) * 1000
        : null,
    tokenType: typeof tokenType === "string" ? tokenType : "Bearer",
    scope: typeof scope === "string" ? scope : null,
    extra,
  };
}

/** Revoke a token (RFC 7009). Revoking is best effort: a token already gone is fine. */
export async function revokeToken(
  url: string,
  token: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, ...extra }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 400 means the token was already invalid, which is what we wanted.
  if (!response.ok && response.status !== 400)
    throw new OAuthError(
      `The provider didn't revoke it (${response.status}).`,
      null,
      response.status,
    );
}
