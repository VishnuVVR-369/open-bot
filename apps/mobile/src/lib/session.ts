import { useCallback, useEffect } from "react";
import { forgetRunProgress, holdsSignIn, unregisterPushNotifications } from "@/push/register";
import { authClient } from "./auth";
import { releasePhoneConnection, signingOutDuring } from "./phone-egress";
import { clearPresence } from "./presence";
import { queryClient } from "./query";

/**
 * Sign out. Run progress goes first, at once: nothing for the account you leave draws again, and
 * the phone no longer holds this sign-in (`holdsSignIn`). Then the phone connection: its service
 * stops and its credential is forgotten, then its pairing is revoked while the session still
 * works. Then notifications to this phone stop (that needs the session too), the session ends,
 * which clears its cookie from SecureStore, and everything cached is forgotten.
 */
export function signOut(): Promise<void> {
  forgetRunProgress();
  // No pairing may start, or finish, across a sign-out (lib/phone-egress.ts).
  return signingOutDuring(async () => {
    await releasePhoneConnection().catch((error: unknown) =>
      console.warn("couldn't stop the phone connection", error),
    );
    await unregisterPushNotifications().catch(() => {});
    await authClient.signOut().catch(() => {});
    queryClient.clear();
    await clearPresence();
  });
}

export function useSignOut() {
  return useCallback(() => signOut(), []);
}

/** What `authClient.useSession()` says. */
export interface SessionState {
  data: unknown;
  isPending: boolean;
  error: { status?: number } | null;
}

/**
 * Whether the server said there is no session: it answered with none, or refused the cookie
 * (401). Still loading, or no answer (offline, a server error), says nothing: the session may
 * still be good, and the app keeps what it has. Better Auth keeps the session it last had while
 * it can't check (`data`), and sets it to null only on such an answer, or when the session it
 * kept from before has expired on the phone's clock and there's no answer yet; that last case
 * has an error and no 401, so it says nothing either.
 */
export function sessionEnded(state: SessionState): boolean {
  if (state.isPending || state.data) return false;
  return state.error === null || state.error.status === 401;
}

/**
 * The session ended without this phone signing out: it expired, or was revoked elsewhere. Once
 * the server says so, this phone signs out too, the same way as when you do, so nothing kept for
 * that sign-in outlives it: run progress, notifications and the phone connection. A phone that
 * holds no sign-in (signed out already, or never signed in) has nothing to tear down.
 */
export function useSignOutWhenSessionEnds(state: SessionState) {
  const ended = sessionEnded(state);
  useEffect(() => {
    if (ended && holdsSignIn()) void signOut();
  }, [ended]);
}
