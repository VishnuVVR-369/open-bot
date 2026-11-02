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
