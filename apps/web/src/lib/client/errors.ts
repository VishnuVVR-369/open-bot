import { ORPCError } from "@orpc/client";

/** How a failed API call failed, so a view can tell "offline" from "broken". */

/** True when the request failed because the computer (the worker) isn't reachable. */
export function isOffline(error: unknown): boolean {
  return error instanceof ORPCError && (error.status === 503 || error.status === 502);
}

/** True when the session is gone (signed out elsewhere, or expired). */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "UNAUTHORIZED";
}

/** True when what was asked for no longer exists, like a deleted page. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "NOT_FOUND";
}
