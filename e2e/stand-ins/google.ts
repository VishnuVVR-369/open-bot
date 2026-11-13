import {
  b64url,
  bearer,
  type Exchange,
  form,
  HOUR,
  json,
  OUR_TOKEN,
  page,
  redirect,
  s256,
  token,
} from "./http";

/** The Google OAuth client the tests paste into Settings. */
export const GOOGLE_CLIENT = {
  clientId: "e2e-open-bot.apps.googleusercontent.com",
  clientSecret: "e2e-google-client-secret",
};

export interface GoogleUser {
  sub: string;
  email: string;
}

/** Who signs in to Google, unless a test says otherwise. */
export const GOOGLE_USER: GoogleUser = {
  sub: "e2e-google-owner",
  email: "e2e.owner@open-bot.test",
};

export const SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
} as const;

/** Google's error body, as its APIs send it. */
export function googleError(ex: Exchange, status: number, message: string, reason?: string) {
  const statusText: Record<number, string> = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    409: "ALREADY_EXISTS",
    410: "NOT_FOUND",
    412: "FAILED_PRECONDITION",
  };
  json(ex, status, {
    error: {
      code: status,
      message,
      errors: reason ? [{ message, domain: "global", reason }] : [],
      status: statusText[status] ?? "UNKNOWN",
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Google sign-in

interface GoogleGrant {
  clientId: string;
  user: GoogleUser;
  scopes: Set<string>;
  revoked: boolean;
}

interface GoogleAccess {
  grant: GoogleGrant;
  scopes: Set<string>;
  expiresAt: number;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: Set<string>;
  user: GoogleUser;
  /** Google issues a refresh token on first consent, and on `prompt=consent`. */
  refresh: boolean;
  used: boolean;
}

/** Google's OAuth: authorization with granular consent, tokens, revocation, userinfo. */
export class GoogleStandIn {
  readonly clients = new Map<string, { secret: string; redirectUris: Set<string> }>();
  /** By client and user. */
  readonly grants = new Map<string, GoogleGrant>();
  readonly accessTokens = new Map<string, GoogleAccess>();
  readonly refreshTokens = new Map<string, GoogleGrant>();
  readonly codes = new Map<string, PendingCode>();
  /** Every authorization request's parameters, as the browser brought them. */
  readonly authorizations: Record<string, string>[] = [];
  /** Every token request's grant type. */
  readonly tokenRequests: string[] = [];
  /** Tokens revoked through the revoke endpoint. */
  readonly revocations: string[] = [];
  /** Consent unticks these scopes, as Google's granular consent lets you. */
  dropScopes: string[] = [];
  /** The user says no on the consent screen. */
  deny = false;
  /** Who signs in. */
  signInAs: GoogleUser = GOOGLE_USER;
  /** Refreshing answers this error. */
  refreshError: { status: number; error: string; description: string } | null = null;

  registerClient(client = GOOGLE_CLIENT, redirectUris: string[]) {
    this.clients.set(client.clientId, {
      secret: client.clientSecret,
      redirectUris: new Set(redirectUris),
    });
  }

  /** The user removes the app under Third-party access: every token stops working. */
  revokeAll() {
    for (const grant of this.grants.values()) grant.revoked = true;
  }

  /** Every access token expires, so the next call refreshes. */
  expireAccessTokens() {
    for (const access of this.accessTokens.values()) access.expiresAt = 0;
  }

  /** The scopes the user's grant holds now. */
  grantedScopes(user = GOOGLE_USER, clientId = GOOGLE_CLIENT.clientId): string[] {
    const grant = this.grants.get(`${clientId}|${user.sub}`);
    return grant && !grant.revoked ? [...grant.scopes] : [];
  }

  lastAuthorization(): Record<string, string> | undefined {
    return this.authorizations[this.authorizations.length - 1];
  }

  /** The grant behind an access token, if it still works. */
  access(value: string | null): GoogleAccess | null {
    const access = value ? this.accessTokens.get(value) : undefined;
    if (!access || access.grant.revoked || access.expiresAt <= Date.now()) return null;
    return access;
  }

  handle(ex: Exchange): boolean {
    const routes: Record<string, (ex: Exchange) => void> = {
      "GET /o/oauth2/v2/auth": (e) => this.authorize(e),
      "POST /token": (e) => this.token(e),
      "POST /revoke": (e) => this.revoke(e),
      "GET /userinfo": (e) => this.userinfo(e),
    };
    const route = routes[`${ex.method} ${ex.url.pathname}`];
    route?.(ex);
    return Boolean(route);
  }

  private authorize(ex: Exchange) {
    const params = Object.fromEntries(ex.url.searchParams);
    this.authorizations.push(params);
    const client = this.clients.get(params.client_id ?? "");
    if (!client)
      return page(ex, 401, "Error 401: invalid_client", "The OAuth client was not found.");
    const redirectUri = params.redirect_uri ?? "";
    if (!client.redirectUris.has(redirectUri))
      return page(
        ex,
        400,
        "Error 400: redirect_uri_mismatch",
        `${redirectUri} isn't an authorized redirect URI for this client.`,
      );
    const back = new URL(redirectUri);
    if (params.state) back.searchParams.set("state", params.state);
    const fail = (error: string) => {
      back.searchParams.set("error", error);
      redirect(ex, back.toString());
    };
    if (params.response_type !== "code") return fail("unsupported_response_type");
    if (params.code_challenge_method !== "S256" || !params.code_challenge)
      return fail("invalid_request");
    if (this.deny) return fail("access_denied");
    const requested = (params.scope ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((scope) => (scope === "email" ? SCOPES.email : scope));
    const dropped = new Set(
      this.dropScopes
        .map((scope) => (scope === "email" ? SCOPES.email : scope))
        .filter((scope) => scope !== SCOPES.openid && scope !== SCOPES.email),
    );
    const scopes = new Set(requested.filter((scope) => !dropped.has(scope)));
    const user = this.signInAs;
    const grant = this.grants.get(`${params.client_id}|${user.sub}`);
    const live = grant && !grant.revoked ? grant : null;
    if (params.include_granted_scopes === "true" && live)
      for (const scope of live.scopes) scopes.add(scope);
    const code = token("google-code");
    this.codes.set(code, {
      clientId: params.client_id!,
      redirectUri,
      challenge: params.code_challenge,
      scopes,
      user,
      refresh: params.access_type === "offline" && (params.prompt === "consent" || !live),
      used: false,
    });
    back.searchParams.set("code", code);
    back.searchParams.set("scope", [...scopes].join(" "));
    redirect(ex, back.toString());
  }

  private clientOf(ex: Exchange, body: URLSearchParams): string | null {
    let clientId = body.get("client_id");
    let secret = body.get("client_secret");
    const basic = /^Basic\s+(\S+)$/i.exec(ex.req.headers.authorization ?? "")?.[1];
    if (basic) {
      const [id, pass] = Buffer.from(basic, "base64").toString("utf8").split(":");
      clientId = decodeURIComponent(id ?? "");
      secret = decodeURIComponent(pass ?? "");
    }
    const client = clientId ? this.clients.get(clientId) : undefined;
    return client && client.secret === secret ? clientId : null;
  }

  private issue(grant: GoogleGrant, refresh: boolean) {
    const accessToken = token("google-at");
    this.accessTokens.set(accessToken, {
      grant,
      scopes: new Set(grant.scopes),
      expiresAt: Date.now() + HOUR * 1000,
    });
    let refreshToken: string | null = null;
    if (refresh) {
      refreshToken = token("google-rt");
      this.refreshTokens.set(refreshToken, grant);
    }
    return {
      access_token: accessToken,
      expires_in: HOUR - 1,
      scope: [...grant.scopes].join(" "),
      token_type: "Bearer",
      id_token: `e2e.${b64url(JSON.stringify({ sub: grant.user.sub, email: grant.user.email }))}.sig`,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  private token(ex: Exchange) {
    const body = form(ex);
    const grantType = body.get("grant_type") ?? "";
    this.tokenRequests.push(grantType);
    const clientId = this.clientOf(ex, body);
    if (!clientId)
      return json(ex, 401, { error: "invalid_client", error_description: "Unauthorized" });
    if (grantType === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "");
      const bad = (description: string) =>
        json(ex, 400, { error: "invalid_grant", error_description: description });
      if (!code || code.used || code.clientId !== clientId) return bad("Malformed auth code.");
      code.used = true;
      if (code.redirectUri !== body.get("redirect_uri")) return bad("Bad Request");
      if (s256(body.get("code_verifier") ?? "") !== code.challenge)
        return bad("Invalid code verifier.");
      const key = `${clientId}|${code.user.sub}`;
      const existing = this.grants.get(key);
      const grant: GoogleGrant =
        existing && !existing.revoked
          ? existing
          : { clientId, user: code.user, scopes: new Set(), revoked: false };
      grant.scopes = new Set(code.scopes);
      this.grants.set(key, grant);
      return json(ex, 200, this.issue(grant, code.refresh));
    }
    if (grantType === "refresh_token") {
      const value = body.get("refresh_token") ?? "";
      const grant = this.refreshTokens.get(value);
      if (!grant)
        return OUR_TOKEN.test(value)
          ? json(ex, 400, {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            })
          : json(ex, 503, {
              error: "temporarily_unavailable",
              error_description: "The E2E stand-in never issued this refresh token.",
            });
      if (this.refreshError)
        return json(ex, this.refreshError.status, {
          error: this.refreshError.error,
          error_description: this.refreshError.description,
        });
      if (grant.revoked || grant.clientId !== clientId)
        return json(ex, 400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      return json(ex, 200, this.issue(grant, false));
    }
    json(ex, 400, { error: "unsupported_grant_type", error_description: `Invalid grant_type` });
  }

  private revoke(ex: Exchange) {
    const value = form(ex).get("token") ?? "";
    const grant = this.refreshTokens.get(value) ?? this.accessTokens.get(value)?.grant;
    if (!grant || grant.revoked)
      return json(ex, 400, {
        error: "invalid_token",
        error_description: "Token expired or revoked",
      });
    grant.revoked = true;
    this.revocations.push(value);
    json(ex, 200, {});
  }

  private userinfo(ex: Exchange) {
    const access = this.access(bearer(ex));
    if (!access)
      return googleError(ex, 401, "Request is missing required authentication credential.");
    json(ex, 200, {
      sub: access.grant.user.sub,
      email: access.grant.user.email,
      email_verified: true,
      picture: "https://lh3.googleusercontent.com/a/e2e",
    });
  }
}

/** Answers 401 or 403 the way Google's APIs do, or returns the caller's access. */
export function googleAuth(
  google: GoogleStandIn,
  ex: Exchange,
  anyOf: readonly string[],
): GoogleAccess | null {
  const access = google.access(bearer(ex));
  if (!access) {
    googleError(
      ex,
      401,
      "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
      "authError",
    );
    return null;
  }
  if (!anyOf.some((scope) => access.scopes.has(scope))) {
    googleError(
      ex,
      403,
      "Request had insufficient authentication scopes.",
      "insufficientPermissions",
    );
    return null;
  }
  return access;
}
