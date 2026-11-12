import { createHmac, timingSafeEqual } from "node:crypto";
import type { EgressAgentKind } from "../egress/settings";

/**
 * Short-lived signed tokens that the web server issues and the worker verifies,
 * for connections that can't carry the session cookie (VNC and the egress tunnel).
 */

export type TokenPurpose = "vnc" | "egress";

/** Which device an egress token is for, so the worker never has to take the client's word. */
export interface EgressAgentClaim {
  kind: EgressAgentKind;
  /** The device's stable id: a phone's paired device id, or the desktop app's install id. */
  id: string;
  name: string;
  /** A phone's credential generation; a newer pairing makes tokens from older ones useless. */
  generation?: number;
}

export interface TokenClaims {
  purpose: TokenPurpose;
  /** Expiry, in seconds since the epoch. */
  exp: number;
  agent?: EgressAgentClaim;
}

/** The identity of an egress token without an `agent` claim, as older web servers issued them. */
export const LEGACY_DESKTOP_AGENT: EgressAgentClaim = {
  kind: "desktop",
  id: "desktop",
  name: "Desktop app",
};

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueToken(
  purpose: TokenPurpose,
  secret: string,
  ttlSeconds: number,
  extra: { agent?: EgressAgentClaim } = {},
): string {
  const claims: TokenClaims = {
    purpose,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...extra,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** The token's claims if it is genuine, unexpired and for this purpose; otherwise null. */
export function readToken(
  token: string,
  purpose: TokenPurpose,
  secret: string,
): TokenClaims | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenClaims;
    return claims.purpose === purpose && claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
}

export function verifyToken(token: string, purpose: TokenPurpose, secret: string): boolean {
  return readToken(token, purpose, secret) !== null;
}
