import { requireNativeModule } from "expo";

interface PasskeyModule {
  /** Make a passkey: WebAuthn creation options in, the registration response out (JSON). */
  create(requestJson: string): Promise<string>;
  /** Use a passkey: WebAuthn request options in, the authentication response out (JSON). */
  get(requestJson: string): Promise<string>;
}

/** Android's Credential Manager, for passkeys (see android/). */
export const NativePasskey = requireNativeModule<PasskeyModule>("OpenBotPasskey");

/** Why a ceremony didn't finish, from the native module's error codes. */
export type PasskeyFailure = "cancelled" | "none" | "unavailable" | "failed";

export function passkeyFailure(error: unknown): PasskeyFailure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "cancelled" || code === "none" || code === "unavailable" ? code : "failed";
}
