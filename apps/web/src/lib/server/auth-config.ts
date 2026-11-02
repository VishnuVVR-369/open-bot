import "server-only";

/** Where the app is served. Passkeys are bound to its hostname. */
export const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/** The phone app's scheme, which its auth requests carry as their origin. */
export const MOBILE_ORIGIN = "openbot://";

/** Origins that may use your session: this site, the desktop app and the phone app. */
export const TRUSTED_ORIGINS = [new URL(BASE_URL).origin, "app://open-bot", MOBILE_ORIGIN];

/** The Android app's id, for its domain association and passkeys. */
export const ANDROID_PACKAGE = "dev.openbot.mobile";

/**
 * SHA-256 fingerprints of the certificates the Android app is signed with, as `keytool -list`
 * prints them (`AB:CD:...`), from `ANDROID_CERT_SHA256` (comma-separated). Only the release key
 * belongs there in production.
 */
export function androidCertFingerprints(
  env: string | undefined = process.env.ANDROID_CERT_SHA256,
): string[] {
  return (env ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
    .map((value) => {
      const hex = value.replace(/:/g, "");
      if (!/^[0-9A-F]{64}$/.test(hex))
        throw new Error("ANDROID_CERT_SHA256 must be SHA-256 fingerprints like AB:CD:...");
      return hex.match(/../g)!.join(":");
    });
}

/**
 * The origins a passkey ceremony may come from: the website, and the Android app, which signs in
 * as `android:apk-key-hash:<base64url of its signing certificate's SHA-256>`.
 */
export function passkeyOrigins(fingerprints: string[] = androidCertFingerprints()): string[] {
  return [
    new URL(BASE_URL).origin,
    ...fingerprints.map(
      (fingerprint) =>
        `android:apk-key-hash:${Buffer.from(fingerprint.replace(/:/g, ""), "hex").toString("base64url")}`,
    ),
  ];
}
