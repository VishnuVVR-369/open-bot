import { useCallback } from "react";
import { unregisterPushNotifications } from "@/push/register";
import { authClient } from "./auth";
import { releasePhoneConnection, signingOutDuring } from "./phone-egress";
import { clearPresence } from "./presence";
import { queryClient } from "./query";

/**
 * Sign out. The phone connection goes first: its service stops and its credential is forgotten
 * before anything else, then its pairing is revoked while the session still works. Then
 * notifications to this phone stop (that needs the session too), the session ends, which clears
 * its cookie from SecureStore, and everything cached is forgotten.
 */
export function signOut(): Promise<void> {
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
