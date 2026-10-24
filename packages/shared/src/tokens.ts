import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed tokens that the web server issues and the worker verifies,
 * for connections that can't carry the session cookie (VNC and the egress tunnel).
 */

export type TokenPurpose = "vnc" | "egress";

export interface TokenClaims {
  purpose: TokenPurpose;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueToken(purpose: TokenPurpose, secret: string, ttlSeconds: number): string {
  const claims: TokenClaims = { purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(token: string, purpose: TokenPurpose, secret: string): boolean {
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenClaims;
    return claims.purpose === purpose && claims.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}
