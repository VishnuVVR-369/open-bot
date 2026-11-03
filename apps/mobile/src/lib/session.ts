import { useCallback } from "react";
import { unregisterPushNotifications } from "@/push/register";
import { authClient } from "./auth";
import { clearPresence } from "./presence";
import { queryClient } from "./query";

/**
 * Sign out: stop notifications to this phone first (that needs the session), then end the
 * session, which clears its cookie from SecureStore, then forget everything cached.
 */
export async function signOut(): Promise<void> {
  await unregisterPushNotifications().catch(() => {});
  await authClient.signOut().catch(() => {});
  queryClient.clear();
  await clearPresence();
}

export function useSignOut() {
  return useCallback(() => signOut(), []);
}
