import * as Device from "expo-device";
import { NativePasskey, passkeyFailure } from "../../modules/passkey";
import { authClient } from "./auth";

/**
 * Passkeys, made and used with Android's Credential Manager against the server's passkey
 * endpoints. Both steps of a ceremony go through the auth client, whose cookie jar carries the
 * challenge cookie from the options request to the verify request.
 */

/** What went wrong, in words for the screen; null when you cancelled and there's nothing to say. */
export type PasskeyResult = { ok: true } | { ok: false; message: string | null };

async function call<T>(path: string, init: { method: "GET" | "POST"; body?: object }) {
  const { data, error } = await authClient.$fetch<T>(path, init);
  if (error) throw Object.assign(new Error(error.message ?? "That didn't work."), error);
  return data;
}

function failed(error: unknown, action: "add" | "use"): PasskeyResult {
  switch (passkeyFailure(error)) {
    case "cancelled":
      return { ok: false, message: null };
    case "none":
      return { ok: false, message: "There's no open-bot passkey on this phone yet." };
    case "unavailable":
      return {
        ok: false,
        message: "This phone can't use passkeys. Sign in to Google Password Manager first.",
      };
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "SESSION_NOT_FRESH")
    return { ok: false, message: "Sign in again with your password, then add the passkey." };
  if (error instanceof TypeError)
    return { ok: false, message: "Couldn't reach open-bot. Check your connection." };
  return {
    ok: false,
    message:
      action === "add"
        ? "Couldn't add the passkey. Try again."
        : "Couldn't sign in with a passkey. Try again or use your password.",
  };
}

/** Add a passkey for your account, kept by this phone's password manager. */
export async function addPasskey(): Promise<PasskeyResult> {
  try {
    const options = await call<object>("/passkey/generate-register-options", { method: "GET" });
    const response = await NativePasskey.create(JSON.stringify(options));
    await call("/passkey/verify-registration", {
      method: "POST",
      body: { response: JSON.parse(response), name: Device.modelName ?? "Android phone" },
    });
    return { ok: true };
  } catch (error) {
    return failed(error, "add");
  }
}

/** Sign in with a passkey. The session cookie it sets signs the app in. */
export async function signInWithPasskey(): Promise<PasskeyResult> {
  try {
    const options = await call<object>("/passkey/generate-authenticate-options", {
      method: "GET",
    });
    const response = await NativePasskey.get(JSON.stringify(options));
    await call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: JSON.parse(response) },
    });
    return { ok: true };
  } catch (error) {
    return failed(error, "use");
  }
}
