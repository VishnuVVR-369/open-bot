import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * One server standing in for Google (OAuth, Gmail and Calendar) and for Notion's hosted MCP (its
 * OAuth with dynamic client registration and PKCE, and its tools), so the accounts feature can be
 * tested end to end without real accounts. Start the web app and the worker pointed at it:
 *
 *   GOOGLE_BASE_URL=http://127.0.0.1:4796 NOTION_MCP_URL=http://127.0.0.1:4796/mcp pnpm dev
 *
 * It speaks the providers' formats as the app reads them: Google's error bodies, Gmail's message
 * resources and search syntax, Calendar's etags and ids, Notion's rotating refresh tokens. Tests
 * drive it in process (the methods below are its control API); `GET /_control/state` shows its
 * state while a test runs.
 *
 * Refresh tokens it never issued get a passing failure, not `invalid_grant`, so a run against the
 * wrong database can't mark someone's real account for reconnecting.
 */

export const STAND_IN_PORT = 4796;
export const STAND_IN_URL = `http://127.0.0.1:${STAND_IN_PORT}`;

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

export const NOTION_WORKSPACE = {
  id: "e2e00000-0000-4000-8000-00000000a001",
  name: "E2E Workspace",
  userId: "e2e00000-0000-4000-8000-00000000b001",
  botId: "e2e00000-0000-4000-8000-00000000c001",
};

/** How the app records the Notion account: workspace and user. */
export const NOTION_EXTERNAL_ID = `${NOTION_WORKSPACE.id}:${NOTION_WORKSPACE.userId}`;

/** Seeded Notion pages, by their 32-digit ids. */
export const NOTION_PAGES = {
  area: "1a2b3c4d5e6f40718293a4b5c6d7e8f9",
  roadmap: "2b3c4d5e6f7040818293a4b5c6d7e8fa",
  notes: "3c4d5e6f708140918293a4b5c6d7e8fb",
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

/** The names of every tool the stand-in's Notion MCP offers, as Notion names them. */
export const NOTION_TOOL_NAMES = [
  "notion-search",
  "notion-fetch",
  "notion-query-data-sources",
  "notion-get-comments",
  "notion-get-users",
  "notion-create-pages",
  "notion-update-page",
  "notion-move-pages",
  "notion-duplicate-page",
  "notion-create-database",
  "notion-update-data-source",
  "notion-create-comment",
  "notion-get-async-task",
] as const;

const OUR_TOKEN = /^e2e-/;
const HOUR = 3600;

const id16 = () => randomBytes(8).toString("hex");
const token = (kind: string) => `e2e-${kind}-${randomBytes(18).toString("base64url")}`;
const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
/** Notion's ids as it writes them: a UUID with dashes. */
const dashed = (id: string) =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
const notionIdOf = (value: string) => {
  const match =
    /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i.exec(
      value,
    );
  return match ? match.slice(1).join("").toLowerCase() : null;
};

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

interface Exchange {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  body: Buffer;
  /** Do the work, then cut the connection instead of answering: an answer lost on the way. */
  drop: boolean;
}

/** A failure a test plans: the next matching request(s) get it. */
export interface Fault {
  method?: string;
  path: RegExp;
  /** Answer this instead of handling the request. */
  status?: number;
  body?: unknown;
  /** Handle the request, then cut the connection: the client can't tell if it happened. */
  drop?: boolean;
  times?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  query: Record<string, string>;
  at: number;
}

function send(
  ex: Exchange,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
) {
  if (ex.drop) {
    ex.res.socket?.destroy();
    return;
  }
  ex.res.writeHead(status, headers);
  ex.res.end(body);
}

function json(ex: Exchange, status: number, body: unknown, headers: Record<string, string> = {}) {
  send(ex, status, JSON.stringify(body), { "content-type": "application/json", ...headers });
}

function empty(ex: Exchange, status = 204) {
  send(ex, status, "");
}

function redirect(ex: Exchange, location: string) {
  send(ex, 302, "", { location });
}

function page(ex: Exchange, status: number, title: string, text: string) {
  send(
    ex,
    status,
    `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${text}</p>`,
    { "content-type": "text/html; charset=utf-8" },
  );
}

function form(ex: Exchange): URLSearchParams {
  return new URLSearchParams(ex.body.toString("utf8"));
}

function jsonBody(ex: Exchange): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(ex.body.toString("utf8") || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bearer(ex: Exchange): string | null {
  const header = ex.req.headers.authorization ?? "";
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
}

/** Google's error body, as its APIs send it. */
function googleError(ex: Exchange, status: number, message: string, reason?: string) {
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
// MIME, as far as Gmail's resources need it

interface MimePart {
  headers: { name: string; value: string }[];
  mimeType: string;
  filename: string;
  /** Decoded content, for leaf parts. */
  content: Buffer;
  parts: MimePart[];
}

function decodeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g,
    (_match, _charset: string, encoding: string, text: string) =>
      encoding.toLowerCase() === "b"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(
            text
              .replace(/_/g, " ")
              .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
            "latin1",
          ).toString("utf8"),
  );
}

function splitHead(raw: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  return match
    ? { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) }
    : { head: raw, body: "" };
}

function headerList(head: string): { name: string; value: string }[] {
  return head
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      return colon > 0
        ? [{ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }]
        : [];
    });
}

function withParams(value: string | undefined): { value: string; params: Record<string, string> } {
  const [first = "", ...rest] = (value ?? "").split(";");
  const params: Record<string, string> = {};
  for (const entry of rest) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    params[entry.slice(0, equals).trim().toLowerCase()] = entry
      .slice(equals + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return { value: first.trim().toLowerCase(), params };
}

function decodeContent(text: string, encoding: string | undefined): Buffer {
  const kind = (encoding ?? "").trim().toLowerCase();
  if (kind === "base64") return Buffer.from(text.replace(/\s+/g, ""), "base64");
  if (kind === "quoted-printable")
    return Buffer.from(
      text
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      "latin1",
    );
  return Buffer.from(text, "utf8");
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed === `${delimiter}--`) {
      if (current) parts.push(current.join("\r\n"));
      current = null;
      break;
    }
    if (trimmed === delimiter) {
      if (current) parts.push(current.join("\r\n"));
      current = [];
      continue;
    }
    current?.push(line);
  }
  if (current) parts.push(current.join("\r\n"));
  return parts;
}

export function parseMime(raw: string): MimePart {
  const { head, body } = splitHead(raw);
  const headers = headerList(head);
  const get = (name: string) => headers.find((entry) => entry.name.toLowerCase() === name)?.value;
  const type = withParams(get("content-type") ?? "text/plain");
  const disposition = withParams(get("content-disposition"));
  const filename = decodeWords(disposition.params.filename ?? type.params.name ?? "");
  if (type.value.startsWith("multipart/") && type.params.boundary)
    return {
      headers,
      mimeType: type.value,
      filename,
      content: Buffer.alloc(0),
      parts: splitMultipart(body, type.params.boundary).map(parseMime),
    };
  return {
    headers,
    mimeType: type.value || "text/plain",
    filename,
    content: decodeContent(body, get("content-transfer-encoding")),
    parts: [],
  };
}

/** A header of a message or part, decoded. */
export function headerOf(part: MimePart, name: string): string {
  const wanted = name.toLowerCase();
  return decodeWords(
    part.headers.find((entry) => entry.name.toLowerCase() === wanted)?.value ?? "",
  );
}

/** A raw message's text, as a reader sees it. */
export function messageText(raw: string): string {
  return plainText(parseMime(raw));
}

function plainText(part: MimePart): string {
  if (part.parts.length) {
    const texts = part.parts.map(plainText).filter(Boolean);
    return part.mimeType === "multipart/alternative" ? (texts[0] ?? "") : texts.join("\n");
  }
  if (part.filename) return "";
  if (part.mimeType === "text/plain") return part.content.toString("utf8");
  if (part.mimeType === "text/html")
    return part.content
      .toString("utf8")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return "";
}

function wrap76(text: string): string {
  return text.replace(/.{76}/g, "$&\r\n");
}

export interface SeedAttachment {
  name: string;
  mimeType: string;
  content: string | Buffer;
}

/** A message for the mailbox, written as a sender's mail app would. */
export interface SeedMessage {
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  date?: Date;
  /** Reply in this thread. */
  threadId?: string;
  inReplyTo?: string;
  /** Default INBOX and UNREAD. */
  labels?: string[];
  attachments?: SeedAttachment[];
  messageId?: string;
}

function composeRaw(seed: SeedMessage, owner: string): { raw: string; messageId: string } {
  const messageId = seed.messageId ?? `<${randomUUID()}@${seed.from.split("@")[1] ?? "e2e.test"}>`;
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(seed.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64")),
  ].join("\r\n");
  let content = textPart;
  if (seed.html) {
    const boundary = `alt-${id16()}`;
    content = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      textPart,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      seed.html,
      `--${boundary}--`,
    ].join("\r\n");
  }
  if (seed.attachments?.length) {
    const boundary = `mixed-${id16()}`;
    content = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      content,
      ...seed.attachments.flatMap((attachment) => [
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${attachment.name}"`,
        `Content-Disposition: attachment; filename="${attachment.name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(Buffer.from(attachment.content).toString("base64")),
      ]),
      `--${boundary}--`,
    ].join("\r\n");
  }
  const headers = [
    `From: ${seed.from}`,
    `To: ${(seed.to ?? [owner]).join(", ")}`,
    ...(seed.cc?.length ? [`Cc: ${seed.cc.join(", ")}`] : []),
    `Subject: ${seed.subject}`,
    `Date: ${(seed.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(seed.inReplyTo ? [`In-Reply-To: ${seed.inReplyTo}`, `References: ${seed.inReplyTo}`] : []),
    "MIME-Version: 1.0",
  ];
  return { raw: `${headers.join("\r\n")}\r\n${content}`, messageId };
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
function googleAuth(
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

// ---------------------------------------------------------------------------------------------
// Gmail

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: Set<string>;
  raw: string;
  mime: MimePart;
  internalDate: number;
  /** Attachment ids handed out so far: Gmail gives new ones on each read. */
  attachments: Map<string, Buffer>;
}

export interface SentMessage {
  id: string;
  threadId: string;
  raw: string;
  at: number;
}

const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
  "CATEGORY_PERSONAL",
  "CATEGORY_UPDATES",
];

const GMAIL_READ = [SCOPES.gmailRead, SCOPES.gmailModify] as const;
const GMAIL_DRAFTS_READ = [SCOPES.gmailRead, SCOPES.gmailCompose, SCOPES.gmailModify] as const;
const GMAIL_COMPOSE = [SCOPES.gmailCompose, SCOPES.gmailModify] as const;
const GMAIL_MODIFY = [SCOPES.gmailModify] as const;

/** One Gmail mailbox, the signed-in user's, with Gmail's REST API over it. */
export class GmailStandIn {
  readonly messages = new Map<string, StoredMessage>();
  /** Draft id to message id. */
  readonly drafts = new Map<string, string>();
  readonly labels = new Map<string, { id: string; name: string; type: "system" | "user" }>();
  /** What was sent, exactly as it was sent. */
  readonly sent: SentMessage[] = [];

  constructor(
    private readonly google: GoogleStandIn,
    private readonly owner: () => string,
  ) {
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
    this.labels.set("Label_1", { id: "Label_1", name: "Receipts", type: "user" });
    this.labels.set("Label_2", { id: "Label_2", name: "Follow up", type: "user" });
  }

  /** A message arrives (or is already there). */
  deliver(seed: SeedMessage): { id: string; threadId: string; messageId: string } {
    const { raw, messageId } = composeRaw(seed, this.owner());
    const message = this.store(raw, seed.threadId ?? null, seed.labels ?? ["INBOX", "UNREAD"], {
      internalDate: (seed.date ?? new Date()).getTime(),
    });
    return { id: message.id, threadId: message.threadId, messageId };
  }

  /** The message a draft holds now, as text. */
  draftRaw(draftId: string): string | null {
    const messageId = this.drafts.get(draftId);
    return messageId ? (this.messages.get(messageId)?.raw ?? null) : null;
  }

  /** The user edits a draft in Gmail: a new message replaces the draft's. */
  editDraft(draftId: string, text: string) {
    const messageId = this.drafts.get(draftId);
    const current = messageId ? this.messages.get(messageId) : undefined;
    if (!current) throw new Error(`No draft ${draftId}`);
    const header = (name: string) => headerOf(current.mime, name);
    const { raw } = composeRaw(
      {
        from: header("From"),
        to: header("To")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        subject: header("Subject"),
        text,
        ...(header("In-Reply-To") ? { inReplyTo: header("In-Reply-To") } : {}),
        labels: ["DRAFT"],
      },
      this.owner(),
    );
    this.messages.delete(current.id);
    const next = this.store(raw, current.threadId, ["DRAFT"]);
    this.drafts.set(draftId, next.id);
  }

  /** Each message in a thread, oldest first. */
  thread(threadId: string): StoredMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.internalDate - b.internalDate);
  }

  private store(
    raw: string,
    threadId: string | null,
    labels: string[],
    options: { internalDate?: number } = {},
  ): StoredMessage {
    const id = id16();
    const thread = threadId && this.thread(threadId).length ? threadId : id;
    const message: StoredMessage = {
      id,
      threadId: thread,
      labelIds: new Set(labels),
      raw,
      mime: parseMime(raw),
      internalDate: options.internalDate ?? Date.now(),
      attachments: new Map(),
    };
    this.messages.set(id, message);
    return message;
  }

  handle(ex: Exchange): boolean {
    const prefix = "/gmail/v1/users/me";
    if (!ex.url.pathname.startsWith(`${prefix}/`)) return false;
    const segments = ex.url.pathname
      .slice(prefix.length + 1)
      .split("/")
      .map(decodeURIComponent);
    const [collection, id, sub, subId] = segments;
    const route =
      collection === "messages" && id === "send" && !sub
        ? `${ex.method} messages/send`
        : `${ex.method} ${collection}${id ? "/:id" : ""}${sub ? `/${sub}` : ""}${subId ? "/:sub" : ""}`;
    const need = (scopes: readonly string[]) => googleAuth(this.google, ex, scopes) !== null;
    switch (route) {
      case "GET profile":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        json(ex, 200, {
          emailAddress: this.owner(),
          messagesTotal: this.messages.size,
          threadsTotal: new Set([...this.messages.values()].map((message) => message.threadId))
            .size,
          historyId: "1000",
        });
        return true;
      case "GET labels":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        json(ex, 200, {
          labels: [...this.labels.values()].map((label) => ({
            ...label,
            ...(label.type === "user"
              ? { labelListVisibility: "labelShow", messageListVisibility: "show" }
              : {}),
          })),
        });
        return true;
      case "GET threads":
        if (!need(GMAIL_READ)) return true;
        this.listThreads(ex);
        return true;
      case "GET threads/:id":
        if (!need(GMAIL_READ)) return true;
        this.getThread(ex, id!);
        return true;
      case "POST threads/:id/modify":
        if (!need(GMAIL_MODIFY)) return true;
        this.modify(ex, id!);
        return true;
      case "GET messages":
        if (!need(GMAIL_READ)) return true;
        this.listMessages(ex);
        return true;
      case "GET messages/:id":
        if (!need(GMAIL_READ)) return true;
        this.getMessage(ex, id!);
        return true;
      case "GET messages/:id/attachments/:sub":
        if (!need(GMAIL_READ)) return true;
        this.getAttachment(ex, id!, subId!);
        return true;
      case "POST messages/send":
        if (!need(GMAIL_COMPOSE)) return true;
        this.sendMessage(ex);
        return true;
      case "GET drafts":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        this.listDrafts(ex);
        return true;
      case "POST drafts":
        if (!need(GMAIL_COMPOSE)) return true;
        this.createDraft(ex);
        return true;
      case "GET drafts/:id":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        this.getDraft(ex, id!);
        return true;
      case "PUT drafts/:id":
        if (!need(GMAIL_COMPOSE)) return true;
        this.updateDraft(ex, id!);
        return true;
      case "DELETE drafts/:id":
        if (!need(GMAIL_COMPOSE)) return true;
        this.deleteDraft(ex, id!);
        return true;
      default:
        googleError(ex, 404, `Not found: ${ex.method} ${ex.url.pathname}`);
        return true;
    }
  }

  private resource(message: StoredMessage, format: string, metadataHeaders: string[]) {
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: [...message.labelIds],
      snippet: plainText(message.mime).replace(/\s+/g, " ").trim().slice(0, 160),
      historyId: "1000",
      internalDate: String(message.internalDate),
      sizeEstimate: Buffer.byteLength(message.raw),
    };
    if (format === "minimal") return base;
    if (format === "raw") return { ...base, raw: b64url(message.raw) };
    if (format === "metadata") {
      const wanted = new Set(metadataHeaders.map((name) => name.toLowerCase()));
      return {
        ...base,
        payload: {
          mimeType: message.mime.mimeType,
          headers: message.mime.headers.filter(
            (entry) => wanted.size === 0 || wanted.has(entry.name.toLowerCase()),
          ),
        },
      };
    }
    const part = (mime: MimePart, partId: string): Record<string, unknown> => {
      const attachment = Boolean(mime.filename) && mime.parts.length === 0;
      let body: Record<string, unknown> = { size: mime.content.length };
      if (attachment) {
        const attachmentId = `ANGjdJ_${randomBytes(24).toString("base64url")}`;
        message.attachments.set(attachmentId, mime.content);
        body = { attachmentId, size: mime.content.length };
      } else if (mime.parts.length === 0) body.data = b64url(mime.content);
      return {
        partId,
        mimeType: mime.mimeType,
        filename: mime.filename,
        headers: mime.headers,
        body,
        ...(mime.parts.length
          ? {
              parts: mime.parts.map((child, index) =>
                part(child, partId ? `${partId}.${index}` : String(index)),
              ),
            }
          : {}),
      };
    };
    return { ...base, payload: part(message.mime, "") };
  }

  private format(ex: Exchange, fallback = "full") {
    return {
      format: ex.url.searchParams.get("format") ?? fallback,
      headers: ex.url.searchParams.getAll("metadataHeaders"),
    };
  }

  /** Gmail's search syntax, as far as teammates use it. */
  private matcher(q: string): (message: StoredMessage) => boolean {
    const terms: { negate: boolean; op: string; value: string }[] = [];
    for (const match of q.matchAll(/(-)?(?:([a-z][a-z0-9_]*):)?("[^"]*"|\S+)/gi)) {
      const value = (match[3] ?? "").replace(/^"(.*)"$/, "$1").toLowerCase();
      if (!match[2] && (value === "or" || value === "and")) continue;
      terms.push({ negate: Boolean(match[1]), op: (match[2] ?? "").toLowerCase(), value });
    }
    const placed = terms.some(
      (term) =>
        (term.op === "in" && ["spam", "trash", "anywhere"].includes(term.value)) ||
        (term.op === "is" && ["spam", "trash"].includes(term.value)),
    );
    const age = (value: string) => {
      const found = /^(\d+)([hdmy])$/.exec(value);
      if (!found) return 0;
      const unit = { h: 3600e3, d: 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[
        found[2] as "h" | "d" | "m" | "y"
      ];
      return Number(found[1]) * unit;
    };
    const day = (value: string) =>
      /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value.replace(/\//g, "-"));
    const labelIs = (message: StoredMessage, name: string) => {
      const wanted = name.replace(/[-/]/g, " ");
      return [...message.labelIds].some((id) => {
        const label = this.labels.get(id);
        return (
          id.toLowerCase() === name ||
          (label?.name.toLowerCase().replace(/[-/]/g, " ") ?? "") === wanted
        );
      });
    };
    return (message) => {
      if (!placed && (message.labelIds.has("SPAM") || message.labelIds.has("TRASH"))) return false;
      const header = (name: string) => headerOf(message.mime, name).toLowerCase();
      const recipients = `${header("To")} ${header("Cc")} ${header("Bcc")}`;
      return terms.every((term) => {
        const { op, value } = term;
        let hit: boolean;
        switch (op) {
          case "from":
            hit = header("From").includes(value);
            break;
          case "to":
            hit = recipients.includes(value);
            break;
          case "cc":
            hit = header("Cc").includes(value);
            break;
          case "subject":
            hit = header("Subject").includes(value);
            break;
          case "in":
          case "is":
            hit =
              value === "anywhere"
                ? true
                : value === "read"
                  ? !message.labelIds.has("UNREAD")
                  : message.labelIds.has(value === "drafts" ? "DRAFT" : value.toUpperCase());
            break;
          case "label":
            hit = labelIs(message, value);
            break;
          case "has":
            hit = value === "attachment" && /\bfilename=/i.test(message.raw);
            break;
          case "filename":
            hit = message.raw.toLowerCase().includes(`filename="${value}`);
            break;
          case "newer_than":
            hit = message.internalDate >= Date.now() - age(value);
            break;
          case "older_than":
            hit = message.internalDate < Date.now() - age(value);
            break;
          case "after":
            hit = message.internalDate >= day(value);
            break;
          case "before":
            hit = message.internalDate < day(value);
            break;
          case "rfc822msgid":
            hit = header("Message-ID").replace(/[<>]/g, "") === value.replace(/[<>]/g, "");
            break;
          default:
            hit = `${header("From")} ${recipients} ${header("Subject")} ${plainText(message.mime)}`
              .toLowerCase()
              .includes(value);
        }
        return term.negate ? !hit : hit;
      });
    };
  }

  private limit(ex: Exchange, fallback = 100) {
    const value = Number(ex.url.searchParams.get("maxResults") ?? fallback);
    return Math.min(Math.max(Number.isFinite(value) ? value : fallback, 1), 500);
  }

  private listThreads(ex: Exchange) {
    const matches = this.matcher(ex.url.searchParams.get("q") ?? "");
    const threads = new Map<string, StoredMessage[]>();
    for (const message of this.messages.values()) {
      const list = threads.get(message.threadId) ?? [];
      list.push(message);
      threads.set(message.threadId, list);
    }
    const found = [...threads.entries()]
      .filter(([, messages]) => messages.some(matches))
      .map(([id, messages]) => ({ id, latest: Math.max(...messages.map((m) => m.internalDate)) }))
      .sort((a, b) => b.latest - a.latest);
    const shown = found.slice(0, this.limit(ex));
    json(ex, 200, {
      ...(shown.length
        ? {
            threads: shown.map(({ id }) => ({
              id,
              snippet: this.resource(this.thread(id).at(-1)!, "minimal", []).snippet,
              historyId: "1000",
            })),
          }
        : {}),
      resultSizeEstimate: found.length,
    });
  }

  private getThread(ex: Exchange, threadId: string) {
    const messages = this.thread(threadId);
    if (!messages.length) return googleError(ex, 404, "Requested entity was not found.");
    const { format, headers } = this.format(ex);
    json(ex, 200, {
      id: threadId,
      historyId: "1000",
      messages: messages.map((message) => this.resource(message, format, headers)),
    });
  }

  private modify(ex: Exchange, threadId: string) {
    const messages = this.thread(threadId);
    if (!messages.length) return googleError(ex, 404, "Requested entity was not found.");
    const body = jsonBody(ex);
    const add = (body.addLabelIds as string[] | undefined) ?? [];
    const remove = (body.removeLabelIds as string[] | undefined) ?? [];
    const unknown = [...add, ...remove].find((label) => !this.labels.has(label));
    if (unknown) return googleError(ex, 400, `Invalid label: ${unknown}`, "invalidArgument");
    for (const message of messages) {
      for (const label of add) message.labelIds.add(label);
      for (const label of remove) message.labelIds.delete(label);
    }
    json(ex, 200, {
      id: threadId,
      messages: messages.map((message) => this.resource(message, "minimal", [])),
    });
  }

  private listMessages(ex: Exchange) {
    const matches = this.matcher(ex.url.searchParams.get("q") ?? "");
    const found = [...this.messages.values()]
      .filter(matches)
      .sort((a, b) => b.internalDate - a.internalDate);
    const shown = found.slice(0, this.limit(ex));
    json(ex, 200, {
      ...(shown.length
        ? { messages: shown.map((message) => ({ id: message.id, threadId: message.threadId })) }
        : {}),
      resultSizeEstimate: found.length,
    });
  }

  private getMessage(ex: Exchange, id: string) {
    const message = this.messages.get(id);
    if (!message) return googleError(ex, 404, "Requested entity was not found.");
    const { format, headers } = this.format(ex);
    json(ex, 200, this.resource(message, format, headers));
  }

  private getAttachment(ex: Exchange, messageId: string, attachmentId: string) {
    const data = this.messages.get(messageId)?.attachments.get(attachmentId);
    if (!data) return googleError(ex, 400, "Invalid attachment token", "invalidArgument");
    json(ex, 200, { attachmentId, size: data.length, data: b64url(data) });
  }

  /** The raw message of a request body, or an answer saying why it can't be one. */
  private rawOf(ex: Exchange, value: unknown): string | null {
    if (typeof value !== "string" || !value) {
      googleError(ex, 400, "Invalid value for ByteString: ", "invalidArgument");
      return null;
    }
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const mime = parseMime(raw);
    if (!headerOf(mime, "To") && !headerOf(mime, "Cc") && !headerOf(mime, "Bcc")) {
      googleError(ex, 400, "Recipient address required", "invalidArgument");
      return null;
    }
    return raw;
  }

  private threadOf(value: unknown): string | null {
    return typeof value === "string" && this.thread(value).length ? value : null;
  }

  private sendMessage(ex: Exchange) {
    const body = jsonBody(ex);
    const raw = this.rawOf(ex, body.raw);
    if (raw === null) return;
    const message = this.store(raw, this.threadOf(body.threadId), ["SENT"]);
    this.sent.push({ id: message.id, threadId: message.threadId, raw, at: Date.now() });
    json(ex, 200, { id: message.id, threadId: message.threadId, labelIds: ["SENT"] });
  }

  private draftResource(draftId: string, format: string, headers: string[] = []) {
    const message = this.messages.get(this.drafts.get(draftId)!)!;
    return { id: draftId, message: this.resource(message, format, headers) };
  }

  private listDrafts(ex: Exchange) {
    const matches = this.matcher(ex.url.searchParams.get("q") ?? "");
    const found = [...this.drafts.entries()].filter(([, messageId]) => {
      const message = this.messages.get(messageId);
      return message ? matches(message) : false;
    });
    const shown = found.slice(0, this.limit(ex));
    json(ex, 200, {
      ...(shown.length
        ? {
            drafts: shown.map(([id, messageId]) => ({
              id,
              message: { id: messageId, threadId: this.messages.get(messageId)!.threadId },
            })),
          }
        : {}),
      resultSizeEstimate: found.length,
    });
  }

  private createDraft(ex: Exchange) {
    const message = jsonBody(ex).message as Record<string, unknown> | undefined;
    const raw = typeof message?.raw === "string" ? Buffer.from(message.raw, "base64url") : null;
    if (!raw) return googleError(ex, 400, "Missing draft message", "invalidArgument");
    const stored = this.store(raw.toString("utf8"), this.threadOf(message?.threadId), ["DRAFT"]);
    const draftId = `r-${randomBytes(9).toString("hex")}`;
    this.drafts.set(draftId, stored.id);
    json(ex, 200, this.draftResource(draftId, "minimal"));
  }

  private getDraft(ex: Exchange, draftId: string) {
    if (!this.drafts.has(draftId)) return googleError(ex, 404, "Requested entity was not found.");
    const { format, headers } = this.format(ex);
    json(ex, 200, this.draftResource(draftId, format, headers));
  }

  private deleteDraft(ex: Exchange, draftId: string) {
    const messageId = this.drafts.get(draftId);
    if (!messageId) return googleError(ex, 404, "Requested entity was not found.");
    this.messages.delete(messageId);
    this.drafts.delete(draftId);
    empty(ex);
  }

  private updateDraft(ex: Exchange, draftId: string) {
    const current = this.drafts.get(draftId);
    if (!current) return googleError(ex, 404, "Requested entity was not found.");
    const message = jsonBody(ex).message as Record<string, unknown> | undefined;
    if (typeof message?.raw !== "string")
      return googleError(ex, 400, "Missing draft message", "invalidArgument");
    const threadId = this.messages.get(current)!.threadId;
    this.messages.delete(current);
    const stored = this.store(
      Buffer.from(message.raw, "base64url").toString("utf8"),
      this.threadOf(message.threadId) ?? threadId,
      ["DRAFT"],
    );
    this.drafts.set(draftId, stored.id);
    json(ex, 200, this.draftResource(draftId, "minimal"));
  }
}

// ---------------------------------------------------------------------------------------------
// Google Calendar

export interface CalendarEvent {
  id: string;
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: {
    email: string;
    responseStatus: string;
    self?: boolean;
    organizer?: boolean;
    comment?: string;
    optional?: boolean;
    resource?: boolean;
  }[];
  [key: string]: unknown;
}

export interface CalendarWrite {
  method: string;
  calendarId: string;
  eventId: string | null;
  sendUpdates: string | null;
  ifMatch: string | null;
  body: Record<string, unknown> | null;
  status: number;
}

const CALENDAR_READ = [SCOPES.calendarRead, SCOPES.calendarEvents] as const;
const CALENDAR_WRITE = [SCOPES.calendarEvents] as const;
const HOLIDAYS = "en.usa#holiday@group.v.calendar.google.com";

/** The signed-in user's calendars, with Calendar's REST API over them. */
export class CalendarStandIn {
  readonly events = new Map<string, Map<string, CalendarEvent>>();
  /** Every change asked for, and how it was answered. */
  readonly writes: CalendarWrite[] = [];
  private etags = 0;

  constructor(
    private readonly google: GoogleStandIn,
    private readonly owner: () => string,
  ) {}

  private calendar(id: string): Map<string, CalendarEvent> | null {
    const resolved = id === "primary" ? this.owner() : id;
    if (resolved !== this.owner() && resolved !== HOLIDAYS) return null;
    let events = this.events.get(resolved);
    if (!events) {
      events = new Map();
      this.events.set(resolved, events);
    }
    return events;
  }

  private etag() {
    this.etags += 1;
    return `"${3_500_000_000_000_000 + this.etags}"`;
  }

  /** An event already on the primary calendar. */
  addEvent(input: {
    summary: string;
    start: Date;
    end: Date;
    guests?: string[];
    description?: string;
    location?: string;
    id?: string;
    /** Someone else's event the user is invited to, rather than the user's own. */
    organizer?: string;
  }): CalendarEvent {
    const event = this.build(
      {
        id: input.id ?? id16(),
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString() },
        end: { dateTime: input.end.toISOString() },
        attendees: (input.guests ?? []).map((email) => ({ email })),
      },
      "0",
    );
    if (input.organizer) {
      event.organizer = { email: input.organizer };
      event.creator = { email: input.organizer };
      event.attendees = [
        { email: input.organizer, organizer: true, responseStatus: "accepted" },
        ...(input.guests ?? []).map((email) => ({ email, responseStatus: "needsAction" })),
        { email: this.owner(), self: true, responseStatus: "needsAction" },
      ];
    }
    this.calendar("primary")!.set(event.id, event);
    return event;
  }

  /** The live event on the primary calendar whose title has this in it, in any case. */
  find(title: string): CalendarEvent | undefined {
    const wanted = title.toLowerCase();
    return [...(this.calendar("primary")?.values() ?? [])].find(
      (event) =>
        event.status !== "cancelled" && (event.summary ?? "").toLowerCase().includes(wanted),
    );
  }

  private attendees(list: unknown, existing: CalendarEvent["attendees"] = []) {
    if (!Array.isArray(list)) return undefined;
    const owner = this.owner().toLowerCase();
    const before = new Map(existing.map((guest) => [guest.email.toLowerCase(), guest]));
    const guests = (list as Record<string, unknown>[])
      .filter((guest) => typeof guest.email === "string")
      .map((guest) => {
        const email = String(guest.email);
        const self = email.toLowerCase() === owner;
        return {
          ...before.get(email.toLowerCase()),
          ...guest,
          email,
          responseStatus: String(
            guest.responseStatus ??
              before.get(email.toLowerCase())?.responseStatus ??
              (self ? "accepted" : "needsAction"),
          ),
          ...(self ? { self: true, organizer: true } : {}),
        };
      });
    // Google lists the organizer among the guests once anyone else is invited.
    if (guests.length && !guests.some((guest) => guest.email.toLowerCase() === owner))
      guests.unshift({
        email: this.owner(),
        responseStatus: "accepted",
        self: true,
        organizer: true,
      });
    return guests;
  }

  private build(body: Record<string, unknown>, conferenceDataVersion: string): CalendarEvent {
    const id = String(body.id);
    const now = new Date().toISOString();
    const create = (body.conferenceData as { createRequest?: Record<string, unknown> } | undefined)
      ?.createRequest;
    const meet = `https://meet.google.com/e2e-${id.slice(0, 4)}-${id.slice(4, 8)}`;
    const attendees = this.attendees(body.attendees);
    return {
      ...body,
      kind: "calendar#event",
      id,
      etag: this.etag(),
      status: "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${b64url(`${id} ${this.owner()}`)}`,
      created: now,
      updated: now,
      iCalUID: `${id}@google.com`,
      sequence: 0,
      creator: { email: this.owner(), self: true },
      organizer: { email: this.owner(), self: true },
      start: body.start as CalendarEvent["start"],
      end: body.end as CalendarEvent["end"],
      ...(attendees ? { attendees } : {}),
      ...(create && conferenceDataVersion === "1"
        ? {
            hangoutLink: meet,
            conferenceData: {
              createRequest: { ...create, status: { statusCode: "success" } },
              entryPoints: [{ entryPointType: "video", uri: meet, label: meet.slice(8) }],
              conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
              conferenceId: meet.split("/").pop(),
            },
          }
        : { conferenceData: undefined }),
    } as CalendarEvent;
  }

  handle(ex: Exchange): boolean {
    const prefix = "/calendar/v3";
    if (!ex.url.pathname.startsWith(`${prefix}/`)) return false;
    const path = ex.url.pathname.slice(prefix.length);
    if (ex.method === "GET" && path === "/users/me/calendarList") {
      if (!googleAuth(this.google, ex, CALENDAR_READ)) return true;
      json(ex, 200, {
        kind: "calendar#calendarList",
        items: [
          {
            id: this.owner(),
            summary: this.owner(),
            primary: true,
            accessRole: "owner",
            timeZone: "Europe/Berlin",
          },
          { id: HOLIDAYS, summary: "Holidays", accessRole: "reader", timeZone: "Europe/Berlin" },
        ],
      });
      return true;
    }
    if (ex.method === "POST" && path === "/freeBusy") {
      if (!googleAuth(this.google, ex, CALENDAR_READ)) return true;
      this.freeBusy(ex);
      return true;
    }
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!match) {
      googleError(ex, 404, "Not Found");
      return true;
    }
    const calendarId = decodeURIComponent(match[1]!);
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;
    const reading = ex.method === "GET";
    if (!googleAuth(this.google, ex, reading ? CALENDAR_READ : CALENDAR_WRITE)) return true;
    const events = this.calendar(calendarId);
    if (!events) {
      googleError(ex, 404, "Not Found", "notFound");
      return true;
    }
    if (!reading && calendarId === HOLIDAYS) {
      googleError(
        ex,
        403,
        "You need to have writer access to this calendar.",
        "requiredAccessLevel",
      );
      return true;
    }
    if (ex.method === "GET" && !eventId) this.list(ex, events);
    else if (ex.method === "GET") {
      const event = events.get(eventId!);
      if (event) json(ex, 200, event);
      else googleError(ex, 404, "Not Found", "notFound");
    } else this.write(ex, calendarId, eventId, events);
    return true;
  }

  private list(ex: Exchange, events: Map<string, CalendarEvent>) {
    const params = ex.url.searchParams;
    const from = Date.parse(params.get("timeMin") ?? "") || -Infinity;
    const to = Date.parse(params.get("timeMax") ?? "") || Infinity;
    const q = (params.get("q") ?? "").toLowerCase();
    const max = Math.min(Number(params.get("maxResults") ?? 250) || 250, 2500);
    const items = [...events.values()]
      .filter((event) => params.get("showDeleted") === "true" || event.status !== "cancelled")
      .filter((event) => startOf(event) < to && endOf(event) > from)
      .filter(
        (event) =>
          !q ||
          `${event.summary ?? ""} ${event.description ?? ""} ${event.location ?? ""}`
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) => startOf(a) - startOf(b))
      .slice(0, max);
    json(ex, 200, {
      kind: "calendar#events",
      summary: this.owner(),
      timeZone: "Europe/Berlin",
      items,
    });
  }

  private freeBusy(ex: Exchange) {
    const body = jsonBody(ex);
    const from = Date.parse(String(body.timeMin ?? ""));
    const to = Date.parse(String(body.timeMax ?? ""));
    const calendars: Record<string, unknown> = {};
    for (const item of (body.items as { id?: string }[] | undefined) ?? []) {
      const id = String(item.id ?? "");
      const events = this.calendar(id);
      calendars[id] = events
        ? {
            busy: [...events.values()]
              .filter(
                (event) => event.status !== "cancelled" && event.transparency !== "transparent",
              )
              .filter((event) => startOf(event) < to && endOf(event) > from)
              .sort((a, b) => startOf(a) - startOf(b))
              .map((event) => ({
                start: new Date(startOf(event)).toISOString(),
                end: new Date(endOf(event)).toISOString(),
              })),
          }
        : { errors: [{ domain: "global", reason: "notFound" }], busy: [] };
    }
    json(ex, 200, {
      kind: "calendar#freeBusy",
      timeMin: body.timeMin,
      timeMax: body.timeMax,
      calendars,
    });
  }

  private write(
    ex: Exchange,
    calendarId: string,
    eventId: string | null,
    events: Map<string, CalendarEvent>,
  ) {
    const params = ex.url.searchParams;
    const body = ex.method === "DELETE" ? null : jsonBody(ex);
    const record: CalendarWrite = {
      method: ex.method,
      calendarId,
      eventId: eventId ?? (typeof body?.id === "string" ? body.id : null),
      sendUpdates: params.get("sendUpdates"),
      ifMatch: (ex.req.headers["if-match"] as string | undefined) ?? null,
      body,
      status: 0,
    };
    this.writes.push(record);
    const answer = (status: number, message?: string, reason?: string, result?: unknown) => {
      record.status = status;
      if (status === 204) empty(ex);
      else if (message) googleError(ex, status, message, reason);
      else json(ex, status, result);
    };
    if (ex.method === "POST" && !eventId) {
      const id = typeof body!.id === "string" ? body!.id : id16();
      if (!/^[a-v0-9]{5,1024}$/.test(id))
        return answer(400, "Invalid resource id value.", "invalid");
      if (events.has(id))
        return answer(409, "The requested identifier already exists.", "duplicate");
      const problem = timeProblem(body!);
      if (problem) return answer(400, problem, "required");
      const event = this.build({ ...body, id }, params.get("conferenceDataVersion") ?? "0");
      events.set(id, event);
      return answer(200, undefined, undefined, event);
    }
    const event = eventId ? events.get(eventId) : undefined;
    if (!event) return answer(404, "Not Found", "notFound");
    if (event.status === "cancelled") return answer(410, "Resource has been deleted", "deleted");
    if (record.ifMatch && record.ifMatch !== event.etag)
      return answer(412, "Precondition Failed", "conditionNotMet");
    if (ex.method === "DELETE") {
      event.status = "cancelled";
      event.etag = this.etag();
      return answer(204);
    }
    if (ex.method !== "PATCH" && ex.method !== "PUT") return answer(404, "Not Found");
    const next: Record<string, unknown> = ex.method === "PUT" ? { id: event.id } : { ...event };
    for (const [key, value] of Object.entries(body!)) {
      if (key === "id" || key === "etag") continue;
      if (value === null) delete next[key];
      else next[key] = key === "attendees" ? this.attendees(value, event.attendees) : value;
    }
    const problem = timeProblem(next);
    if (problem) return answer(400, problem, "required");
    const updated = {
      ...next,
      etag: this.etag(),
      updated: new Date().toISOString(),
      sequence: Number(event.sequence ?? 0) + 1,
    } as unknown as CalendarEvent;
    events.set(event.id, updated);
    return answer(200, undefined, undefined, updated);
  }
}

function instant(time: CalendarEvent["start"] | undefined): number {
  if (!time) return NaN;
  return Date.parse(time.dateTime ?? (time.date ? `${time.date}T00:00:00Z` : ""));
}

function startOf(event: CalendarEvent) {
  return instant(event.start);
}

function endOf(event: CalendarEvent) {
  return instant(event.end);
}

function timeProblem(body: Record<string, unknown>): string | null {
  const start = body.start as CalendarEvent["start"] | undefined;
  const end = body.end as CalendarEvent["end"] | undefined;
  if (!start || (!start.dateTime && !start.date)) return "Missing start time.";
  if (!end || (!end.dateTime && !end.date)) return "Missing end time.";
  const from = instant(start);
  const to = instant(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return "Invalid start or end time.";
  if (to <= from) return "The specified time range is empty.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Notion: OAuth with dynamic client registration, and its hosted MCP server

export interface NotionPage {
  id: string;
  title: string;
  parentId: string | null;
  content: string;
  kind: "page" | "database";
  /** Made through the MCP (a teammate), not seeded. */
  made: boolean;
}

interface NotionGrant {
  clientId: string;
  refreshToken: string;
  /** Refresh tokens rotated away; using one again ends the grant, as Notion does. */
  rotated: Set<string>;
  revoked: boolean;
}

export interface NotionCall {
  tool: string;
  args: Record<string, unknown>;
  at: number;
}

/** Notion's sign-in and MCP tools, over a small workspace. */
export class NotionStandIn {
  readonly clients = new Map<string, { redirectUris: string[]; name: string }>();
  readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; used: boolean }
  >();
  readonly grants: NotionGrant[] = [];
  readonly accessTokens = new Map<string, { grant: NotionGrant; expiresAt: number }>();
  readonly pages = new Map<string, NotionPage>();
  readonly comments: { pageId: string; text: string }[] = [];
  /** Every tool call, in order. */
  readonly calls: NotionCall[] = [];
  readonly authorizations: Record<string, string>[] = [];
  readonly tokenRequests: string[] = [];
  readonly revocations: string[] = [];
  /** Writes answer with an async task, which finishes on the second poll. */
  asyncWrites = false;
  deny = false;
  private readonly tasks = new Map<string, { result: unknown; polls: number }>();
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();

  constructor(private readonly origin: string) {
    this.seedPages();
  }

  private seedPages() {
    const seed = (id: string, title: string, content: string) =>
      this.pages.set(id, { id, title, parentId: null, content, kind: "page", made: false });
    seed(NOTION_PAGES.area, "Teammates", "Pages my teammates keep.");
    seed(
      NOTION_PAGES.roadmap,
      "Roadmap",
      "Q1: ship accounts. Q2: mobile app. Shared with the team.",
    );
    seed(NOTION_PAGES.notes, "Private notes", "Gift ideas for Sam.");
  }

  get resource() {
    return `${this.origin}/mcp`;
  }

  /** Children of a page, as this workspace has them now. */
  childrenOf(pageId: string): NotionPage[] {
    return [...this.pages.values()].filter((entry) => entry.parentId === pageId);
  }

  calledTools(): string[] {
    return this.calls.map((call) => call.tool);
  }

  /** Every access token expires, so the next call refreshes (and rotates). */
  expireAccessTokens() {
    for (const access of this.accessTokens.values()) access.expiresAt = 0;
  }

  /** Notion forgets every MCP session, as after its own deploy. */
  dropSessions() {
    for (const transport of this.sessions.values()) void transport.close();
    this.sessions.clear();
  }

  revokeAll() {
    for (const grant of this.grants) grant.revoked = true;
  }

  private live(value: string | null) {
    const access = value ? this.accessTokens.get(value) : undefined;
    return access && !access.grant.revoked && access.expiresAt > Date.now() ? access : null;
  }

  handle(ex: Exchange): Promise<boolean> | boolean {
    const path = ex.url.pathname;
    if (ex.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      json(ex, 200, {
        resource: this.resource,
        authorization_servers: [this.origin],
        bearer_methods_supported: ["header"],
        resource_name: "Notion MCP (E2E stand-in)",
      });
      return true;
    }
    if (ex.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(ex, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/notion/authorize`,
        token_endpoint: `${this.origin}/notion/token`,
        registration_endpoint: `${this.origin}/notion/register`,
        revocation_endpoint: `${this.origin}/notion/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_post",
          "client_secret_basic",
        ],
      });
      return true;
    }
    if (path === "/mcp") return this.mcp(ex).then(() => true);
    const routes: Record<string, (ex: Exchange) => void> = {
      "POST /notion/register": (e) => this.register(e),
      "GET /notion/authorize": (e) => this.authorize(e),
      "POST /notion/token": (e) => this.token(e),
      "POST /notion/revoke": (e) => this.revoke(e),
    };
    const route = routes[`${ex.method} ${path}`];
    route?.(ex);
    return Boolean(route);
  }

  private register(ex: Exchange) {
    const body = jsonBody(ex);
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every((uri) => typeof uri === "string" && /^https?:\/\//.test(uri))
    )
      return json(ex, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a list of http(s) URLs.",
      });
    const clientId = `e2e-notion-client-${this.clients.size + 1}-${id16()}`;
    this.clients.set(clientId, { redirectUris: uris as string[], name: String(body.client_name) });
    json(ex, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  private authorize(ex: Exchange) {
    const params = Object.fromEntries(ex.url.searchParams);
    this.authorizations.push(params);
    const client = this.clients.get(params.client_id ?? "");
    if (!client) return page(ex, 400, "Invalid client", "This app isn't registered with Notion.");
    if (!client.redirectUris.includes(params.redirect_uri ?? ""))
      return page(ex, 400, "Invalid redirect", "That redirect URI isn't registered.");
    const back = new URL(params.redirect_uri!);
    if (params.state) back.searchParams.set("state", params.state);
    const fail = (error: string) => {
      back.searchParams.set("error", error);
      redirect(ex, back.toString());
    };
    if (params.response_type !== "code") return fail("unsupported_response_type");
    if (params.code_challenge_method !== "S256" || !params.code_challenge)
      return fail("invalid_request");
    if (params.resource && params.resource !== this.resource) return fail("invalid_target");
    if (this.deny) return fail("access_denied");
    const code = token("notion-code");
    this.codes.set(code, {
      clientId: params.client_id!,
      redirectUri: params.redirect_uri!,
      challenge: params.code_challenge,
      used: false,
    });
    back.searchParams.set("code", code);
    redirect(ex, back.toString());
  }

  private issue(grant: NotionGrant, identity: boolean) {
    const accessToken = token("notion-at");
    this.accessTokens.set(accessToken, { grant, expiresAt: Date.now() + HOUR * 1000 });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: HOUR,
      refresh_token: grant.refreshToken,
      ...(identity
        ? {
            workspace_id: NOTION_WORKSPACE.id,
            workspace_name: NOTION_WORKSPACE.name,
            workspace_icon: null,
            bot_id: NOTION_WORKSPACE.botId,
            user_id: NOTION_WORKSPACE.userId,
            owner: { type: "user", user: { id: NOTION_WORKSPACE.userId } },
          }
        : {}),
    };
  }

  private token(ex: Exchange) {
    const body = form(ex);
    const grantType = body.get("grant_type") ?? "";
    this.tokenRequests.push(grantType);
    const clientId = body.get("client_id") ?? "";
    if (!this.clients.has(clientId)) return json(ex, 401, { error: "invalid_client" });
    const bad = (description: string) =>
      json(ex, 400, { error: "invalid_grant", error_description: description });
    if (body.get("resource") && body.get("resource") !== this.resource)
      return json(ex, 400, { error: "invalid_target" });
    if (grantType === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "");
      if (!code || code.used || code.clientId !== clientId) return bad("Invalid code.");
      code.used = true;
      if (code.redirectUri !== body.get("redirect_uri")) return bad("redirect_uri mismatch.");
      if (s256(body.get("code_verifier") ?? "") !== code.challenge)
        return bad("PKCE verification failed.");
      const grant: NotionGrant = {
        clientId,
        refreshToken: token("notion-rt"),
        rotated: new Set(),
        revoked: false,
      };
      this.grants.push(grant);
      return json(ex, 200, this.issue(grant, true));
    }
    if (grantType === "refresh_token") {
      const value = body.get("refresh_token") ?? "";
      const grant = this.grants.find(
        (entry) => entry.refreshToken === value || entry.rotated.has(value),
      );
      if (!grant)
        return OUR_TOKEN.test(value)
          ? bad("Invalid refresh token.")
          : json(ex, 503, { error: "temporarily_unavailable" });
      if (grant.revoked || grant.clientId !== clientId) return bad("The grant was revoked.");
      if (grant.rotated.has(value)) {
        // An old refresh token used again: someone may have stolen it, so the grant ends.
        grant.revoked = true;
        return bad("Refresh token reuse detected.");
      }
      grant.rotated.add(grant.refreshToken);
      grant.refreshToken = token("notion-rt");
      return json(ex, 200, this.issue(grant, false));
    }
    json(ex, 400, { error: "unsupported_grant_type" });
  }

  private revoke(ex: Exchange) {
    const value = form(ex).get("token") ?? "";
    const grant =
      this.grants.find((entry) => entry.refreshToken === value) ??
      this.accessTokens.get(value)?.grant;
    if (grant) grant.revoked = true;
    this.revocations.push(value);
    json(ex, 200, {});
  }

  private async mcp(ex: Exchange) {
    if (!this.live(bearer(ex))) {
      send(ex, 401, JSON.stringify({ error: "invalid_token" }), {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      return;
    }
    let body: unknown;
    try {
      body = ex.body.length ? JSON.parse(ex.body.toString("utf8")) : undefined;
    } catch {
      json(ex, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
    const sessionId = ex.req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const transport = this.sessions.get(sessionId);
      if (!transport) {
        json(ex, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      await transport.handleRequest(ex.req, ex.res, body);
      return;
    }
    if (ex.method !== "POST" || !isInitializeRequest(body)) {
      json(ex, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no session" },
        id: null,
      });
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await this.server().connect(transport);
    await transport.handleRequest(ex.req, ex.res, body);
  }

  private url(entry: NotionPage) {
    return `https://www.notion.so/${entry.title.replace(/[^a-z0-9]+/gi, "-")}-${entry.id}`;
  }

  private find(value: unknown): NotionPage | null {
    const id = typeof value === "string" ? notionIdOf(value) : null;
    return id ? (this.pages.get(id) ?? null) : null;
  }

  private parentOf(raw: unknown): { id: string | null } | { error: string } {
    if (raw === undefined || raw === null) return { id: null };
    const parent = raw as Record<string, unknown>;
    const ref = parent.page_id ?? parent.database_id ?? parent.data_source_id;
    if (typeof ref !== "string") return { error: "Unsupported parent." };
    const found = this.find(ref);
    return found ? { id: found.id } : { error: `Could not find parent ${ref}.` };
  }

  private server(): McpServer {
    const mcp = new McpServer({ name: "Notion MCP (E2E stand-in)", version: "1.0.0" });
    const text = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
    });
    const failure = (message: string) => ({
      content: [{ type: "text" as const, text: message }],
      isError: true,
    });
    const tool = (
      name: (typeof NOTION_TOOL_NAMES)[number],
      description: string,
      shape: z.ZodRawShape,
      run: (args: Record<string, unknown>) => ReturnType<typeof text> | ReturnType<typeof failure>,
    ) =>
      mcp.registerTool(
        name,
        { description, inputSchema: z.looseObject(shape) },
        async (args: Record<string, unknown>) => {
          this.calls.push({ tool: name, args, at: Date.now() });
          return run(args);
        },
      );
    /** A write's answer: now, or as an async task to poll. */
    const written = (result: unknown) => {
      if (!this.asyncWrites) return text(result);
      const id = `task-${id16()}`;
      this.tasks.set(id, { result, polls: 0 });
      return text({ object: "async_task", id, status: "pending", poll_after_seconds: 1 });
    };

    tool("notion-search", "Search the workspace.", { query: z.string() }, (args) => {
      const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [...this.pages.values()].filter((entry) =>
        words.some((word) => `${entry.title} ${entry.content}`.toLowerCase().includes(word)),
      );
      return text({
        type: "workspace_search",
        results: [
          ...hits.map((entry) => ({
            id: dashed(entry.id),
            title: entry.title,
            url: this.url(entry),
            type: entry.kind,
            highlight: entry.content.slice(0, 120),
            timestamp: new Date().toISOString(),
          })),
          // A result from an app connected to Notion, which teammates mustn't get.
          ...(words.length
            ? [
                {
                  id: "slack-e2e-1",
                  title: `Slack: #general mentions ${words[0]}`,
                  url: "https://e2e.slack.com/archives/C1/p1",
                  type: "slack",
                },
              ]
            : []),
        ],
      });
    });
    tool("notion-fetch", "Fetch a page or database.", { id: z.string() }, (args) => {
      const entry = this.find(args.id);
      if (!entry) return failure(`Could not find page or database with ID: ${String(args.id)}`);
      return text({
        metadata: { type: entry.kind },
        title: entry.title,
        url: this.url(entry),
        text: `<page url="${this.url(entry)}">\n<properties>{"title":"${entry.title}"}</properties>\n<content>\n${entry.content}\n</content>\n</page>`,
      });
    });
    tool("notion-query-data-sources", "Query data sources.", {}, () => text({ results: [] }));
    tool("notion-get-comments", "Read a page's comments.", { page_id: z.string() }, (args) => {
      const entry = this.find(args.page_id);
      return text({
        comments: entry ? this.comments.filter((comment) => comment.pageId === entry.id) : [],
      });
    });
    tool("notion-get-users", "List people in the workspace.", {}, () =>
      text({
        results: [
          {
            id: NOTION_WORKSPACE.userId,
            type: "person",
            name: "E2E Owner",
            email: GOOGLE_USER.email,
          },
        ],
        has_more: false,
      }),
    );
    tool("notion-create-pages", "Create pages.", { pages: z.array(z.looseObject({})) }, (args) => {
      const parent = this.parentOf(args.parent);
      if ("error" in parent) return failure(parent.error);
      const made = (args.pages as Record<string, unknown>[]).map((input) => {
        const properties = (input.properties ?? {}) as Record<string, unknown>;
        const title = String(properties.title ?? properties.Title ?? "Untitled");
        const entry: NotionPage = {
          id: randomUUID().replace(/-/g, ""),
          title,
          parentId: parent.id,
          content: typeof input.content === "string" ? input.content : "",
          kind: "page",
          made: true,
        };
        this.pages.set(entry.id, entry);
        return { id: dashed(entry.id), url: this.url(entry), properties: { title } };
      });
      return written({ pages: made });
    });
    tool(
      "notion-update-page",
      "Change a page.",
      { page_id: z.string(), command: z.string() },
      (args) => {
        const entry = this.find(args.page_id);
        if (!entry) return failure(`Could not find page with ID: ${String(args.page_id)}`);
        const command = String(args.command);
        if (command === "update_properties") {
          const properties = (args.properties ?? {}) as Record<string, unknown>;
          if (typeof properties.title === "string") entry.title = properties.title;
        } else if (command === "replace_content") entry.content = String(args.new_str ?? "");
        else if (command === "insert_content_after" || command === "append_content")
          entry.content = `${entry.content}\n${String(args.new_str ?? args.content ?? "")}`;
        else return failure(`Unknown command: ${command}`);
        return written({ page_id: dashed(entry.id), url: this.url(entry) });
      },
    );
    tool(
      "notion-move-pages",
      "Move pages under a new parent.",
      { page_or_database_ids: z.array(z.string()), new_parent: z.looseObject({}) },
      (args) => {
        const parent = this.parentOf(args.new_parent);
        if ("error" in parent) return failure(parent.error);
        const moving = (args.page_or_database_ids as string[]).map((ref) => this.find(ref));
        if (moving.some((entry) => !entry)) return failure("Could not find a page to move.");
        for (const entry of moving) entry!.parentId = parent.id;
        return written({ result: `Moved ${moving.length} pages.` });
      },
    );
    tool("notion-duplicate-page", "Duplicate a page.", { page_id: z.string() }, (args) => {
      const entry = this.find(args.page_id);
      if (!entry) return failure(`Could not find page with ID: ${String(args.page_id)}`);
      const copy = { ...entry, id: randomUUID().replace(/-/g, ""), title: `${entry.title} (1)` };
      this.pages.set(copy.id, copy);
      return written({ page_id: dashed(copy.id), url: this.url(copy) });
    });
    tool("notion-create-database", "Create a database.", {}, (args) => {
      const parent = this.parentOf(args.parent);
      if ("error" in parent) return failure(parent.error);
      const entry: NotionPage = {
        id: randomUUID().replace(/-/g, ""),
        title: typeof args.title === "string" ? args.title : "Untitled database",
        parentId: parent.id,
        content: "",
        kind: "database",
        made: true,
      };
      this.pages.set(entry.id, entry);
      const source = randomUUID();
      return written({
        database: { id: dashed(entry.id), url: this.url(entry) },
        data_sources: [{ id: source, url: `collection://${source}` }],
      });
    });
    tool(
      "notion-update-data-source",
      "Change a data source.",
      { data_source_id: z.string() },
      (args) => written({ data_source_id: args.data_source_id, ok: true }),
    );
    tool("notion-create-comment", "Comment on a page.", {}, (args) => {
      const entry = this.find(args.page_id);
      if (!entry) return failure("Could not find the page to comment on.");
      const comment = JSON.stringify(args.rich_text ?? args.markdown ?? args.text ?? "");
      this.comments.push({ pageId: entry.id, text: comment });
      return written({ comment_id: randomUUID() });
    });
    tool("notion-get-async-task", "Check on a write.", { task_id: z.string() }, (args) => {
      const task = this.tasks.get(String(args.task_id));
      if (!task) return failure("No such task.");
      task.polls += 1;
      return text(
        task.polls >= 2
          ? { status: "succeeded", result: task.result }
          : { status: "in_progress", poll_after_seconds: 1 },
      );
    });
    return mcp;
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((transport) => transport.close()));
    this.sessions.clear();
  }
}

// ---------------------------------------------------------------------------------------------

/** Google and Notion, on one port. */
export class AccountsStandIn {
  google!: GoogleStandIn;
  gmail!: GmailStandIn;
  calendar!: CalendarStandIn;
  notion!: NotionStandIn;
  /** Every provider request, in order. */
  requests: RecordedRequest[] = [];
  private faults: (Fault & { times: number })[] = [];
  private server: http.Server | null = null;

  constructor(readonly origin = STAND_IN_URL) {
    this.reset();
  }

  /** Back to a fresh mailbox, calendar and workspace, with nobody signed in. */
  reset() {
    void this.notion?.close();
    this.google = new GoogleStandIn();
    const owner = () => this.google.signInAs.email;
    this.gmail = new GmailStandIn(this.google, owner);
    this.calendar = new CalendarStandIn(this.google, owner);
    this.notion = new NotionStandIn(this.origin);
    this.requests = [];
    this.faults = [];
  }

  /** The next `times` requests matching get this instead. */
  fail(fault: Fault) {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  /** Requests to a path, like `/gmail/v1/users/me/messages/send`. */
  requestsTo(path: string | RegExp, method?: string): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        (method === undefined || request.method === method) &&
        (typeof path === "string" ? request.path === path : path.test(request.path)),
    );
  }

  /** What tests and people debugging them want to see. */
  state() {
    return {
      google: {
        clients: [...this.google.clients.keys()],
        grantedScopes: this.google.grantedScopes(),
        authorizations: this.google.authorizations,
        tokenRequests: this.google.tokenRequests,
        revocations: this.google.revocations.length,
      },
      gmail: {
        messages: [...this.gmail.messages.values()].map((message) => ({
          id: message.id,
          threadId: message.threadId,
          labels: [...message.labelIds],
          subject: headerOf(message.mime, "Subject"),
          to: headerOf(message.mime, "To"),
        })),
        drafts: [...this.gmail.drafts.keys()],
        sent: this.gmail.sent.map((message) => ({
          id: message.id,
          to: headerOf(parseMime(message.raw), "To"),
          subject: headerOf(parseMime(message.raw), "Subject"),
        })),
      },
      calendar: {
        events: [...this.calendar.events.values()].flatMap((events) => [...events.values()]),
        writes: this.calendar.writes,
      },
      notion: {
        clients: [...this.notion.clients.keys()],
        pages: [...this.notion.pages.values()],
        calls: this.notion.calls,
        revocations: this.notion.revocations.length,
      },
      requests: this.requests.length,
    };
  }

  async start(port = STAND_IN_PORT) {
    this.server = http.createServer((req, res) => {
      void this.serve(req, res).catch((error: unknown) => {
        if (!res.headersSent)
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { code: 500, message: String(error) } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
  }

  async stop() {
    await this.notion.close();
    const server = this.server;
    this.server = null;
    if (!server) return;
    // The MCP client keeps a stream open, which would hold close() up.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", this.origin);
    const ex: Exchange = {
      req,
      res,
      url,
      method: req.method ?? "GET",
      body: Buffer.concat(chunks),
      drop: false,
    };
    if (url.pathname === "/_control/state") return json(ex, 200, this.state());
    this.requests.push({
      method: ex.method,
      path: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams),
      at: Date.now(),
    });
    const fault = this.faults.find(
      (entry) =>
        entry.times > 0 &&
        (entry.method === undefined || entry.method === ex.method) &&
        entry.path.test(url.pathname),
    );
    if (fault) {
      fault.times -= 1;
      if (fault.drop) ex.drop = true;
      else
        return json(
          ex,
          fault.status ?? 500,
          fault.body ?? {
            error: {
              code: fault.status ?? 500,
              message: "Backend Error",
              errors: [{ reason: "backendError" }],
            },
          },
        );
    }
    if (this.google.handle(ex)) return;
    if (this.gmail.handle(ex)) return;
    if (this.calendar.handle(ex)) return;
    if (await this.notion.handle(ex)) return;
    json(ex, 404, { error: { code: 404, message: `Nothing at ${ex.method} ${url.pathname}` } });
  }
}
