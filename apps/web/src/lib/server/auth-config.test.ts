import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { androidCertFingerprints, defaultPasskeyName, passkeyOrigins } from "./auth-config";

const cert = Buffer.from("a release signing certificate");
const digest = createHash("sha256").update(cert).digest();
const fingerprint = digest.toString("hex").toUpperCase().match(/../g)!.join(":");

describe("Android app signing", () => {
  it("reads keytool fingerprints, with or without colons, in any case", () => {
    const bare = digest.toString("hex");
    expect(androidCertFingerprints(` ${bare} , ${fingerprint}`)).toEqual([
      fingerprint,
      fingerprint,
    ]);
    expect(androidCertFingerprints("")).toEqual([]);
    expect(androidCertFingerprints(undefined)).toEqual([]);
  });

  it("refuses anything that isn't a SHA-256 fingerprint", () => {
    expect(() => androidCertFingerprints("AB:CD")).toThrow(/SHA-256 fingerprints/);
  });

  it("accepts passkeys from the website and from the app signed with that key", () => {
    // What Android puts in a native credential's clientDataJSON as its origin.
    expect(passkeyOrigins([fingerprint])).toEqual([
      "http://localhost:3000",
      `android:apk-key-hash:${digest.toString("base64url")}`,
    ]);
  });
});

describe("default passkey name", () => {
  const chromeMac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

  it("names where the passkey is kept when that's known", () => {
    expect(
      defaultPasskeyName({ aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", userAgent: chromeMac }),
    ).toBe("Google Password Manager");
  });

  it("falls back to the browser and device", () => {
    expect(
      defaultPasskeyName({ aaguid: "00000000-0000-0000-0000-000000000000", userAgent: chromeMac }),
    ).toBe("Chrome on Mac");
    expect(defaultPasskeyName({})).toBe("This device");
  });
});
