import "server-only";
import { TRUSTED_ORIGINS } from "./auth-config";

/**
 * Whether a cookie-authenticated request may come from this origin. Native apps send no `Origin`;
 * browsers always do on POST, so a page on another site can't use your session.
 */
export function allowedOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  if (TRUSTED_ORIGINS.includes(origin)) return true;
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Methods a browser lets any site send with your cookies, which must never change anything. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The answer for a write a page on another site sent with the owner's cookies, or null when the
 * request may go on. Every route that changes something on the owner's session goes through it:
 * the API (`/api/rpc`) and `authed()` routes.
 */
export function crossSiteRefusal(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method)) return null;
  if (allowedOrigin(request.headers.get("origin"), request.headers.get("host"))) return null;
  return Response.json({ error: "Requests from other sites aren't allowed." }, { status: 403 });
}
