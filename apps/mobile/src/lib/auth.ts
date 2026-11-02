import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { APP_URL, SCHEME } from "./config";

/**
 * Your open-bot session. Better Auth keeps its cookie in SecureStore (backed by the Android
 * Keystore) and sends it with its own requests; `sessionCookie` gives it to everything else.
 */
export const authClient = createAuthClient({
  baseURL: APP_URL,
  plugins: [expoClient({ scheme: SCHEME, storagePrefix: "openbot", storage: SecureStore })],
});

/** The session cookie, for the API, the stream and anything else that needs to be you. */
export async function sessionCookie(): Promise<string> {
  return authClient.getCookie();
}
