import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Links to one version of a page, which the web server signs and the pages service checks. The
 * pages service never sees your session, so a link is the only way in: it names one version and
 * stops working after a few minutes.
 */

/** How long a link works. Long enough to open a page; a page already open stays open. */
export const PAGE_LINK_TTL_SECONDS = 10 * 60;

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signature(versionId: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(`page:v1:${versionId}:${exp}`).digest("base64url");
}

/** A key for one version, as the `k` query parameter: its expiry and signature. */
export function signPageVersion(
  versionId: string,
  secret: string,
  ttlSeconds = PAGE_LINK_TTL_SECONDS,
  now = Date.now(),
): string {
  if (!VERSION_ID.test(versionId)) throw new Error("Not a page version id");
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return `${exp}.${signature(versionId.toLowerCase(), exp, secret)}`;
}

/** Whether a key opens this version now. */
export function verifyPageVersion(
  versionId: string,
  key: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!VERSION_ID.test(versionId)) return false;
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(key);
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp <= now / 1000) return false;
  const expected = Buffer.from(signature(versionId.toLowerCase(), exp, secret));
  const actual = Buffer.from(match[2]!);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The URL of a version on the pages service, with a fresh key and how to show it. */
export function pageVersionUrl(
  pagesUrl: string,
  versionId: string,
  secret: string,
  query = "",
  ttlSeconds = PAGE_LINK_TTL_SECONDS,
): string {
  const base = pagesUrl.replace(/\/+$/, "");
  const key = signPageVersion(versionId, secret, ttlSeconds);
  return `${base}/v/${versionId}?k=${encodeURIComponent(key)}${query ? `&${query}` : ""}`;
}
