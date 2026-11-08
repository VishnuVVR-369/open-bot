import { passwordChangeError } from "@open-bot/domain";
import { authClient } from "./auth";

/**
 * The owner's sign-in password. The limits and words are shared with the web (@open-bot/domain);
 * this is the server's two ways to set it: with the current one, or within the short window a passkey
 * sign-in opens (apps/web/src/lib/server/passkey-reset.ts), when the current one is forgotten.
 */

type Outcome = { ok: true } | { ok: false; message: string };

function outcome(error: { code?: string } | null | undefined): Outcome {
  return error ? { ok: false, message: passwordChangeError(error.code) } : { ok: true };
}

/** Change it with the current one. Every other device is signed out; this one stays in. */
export async function changePassword(current: string, next: string): Promise<Outcome> {
  try {
    const result = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    return outcome(result.error);
  } catch {
    return { ok: false, message: "Couldn't reach open-bot. Check your connection." };
  }
}

/** Whether this session signed in with a passkey a moment ago, so it may set one without the old. */
export async function canSetWithoutCurrent(): Promise<boolean> {
  try {
    const { data } = await authClient.$fetch<{ ready: boolean }>("/passkey-reset/status", {
      method: "GET",
    });
    return Boolean(data?.ready);
  } catch {
    return false;
  }
}

/** Set a new one in the window a passkey sign-in opened. Signs out every other device. */
export async function setPasswordAfterPasskey(next: string): Promise<Outcome> {
  try {
    const { error } = await authClient.$fetch("/passkey-reset/set-password", {
      method: "POST",
      body: { newPassword: next },
    });
    return outcome(error as { code?: string } | null);
  } catch {
    return { ok: false, message: "Couldn't reach open-bot. Check your connection." };
  }
}

/**
 * Set from "Forgot password?" when you choose your passkey: once you're in, Settings opens the
 * new-password form. Kept in memory only, for the sign-in that's happening now.
 */
let pendingReset = false;

export function requestPasswordReset() {
  pendingReset = true;
}

/** True once, after `requestPasswordReset`. */
export function takePasswordResetRequest(): boolean {
  const pending = pendingReset;
  pendingReset = false;
  return pending;
}
