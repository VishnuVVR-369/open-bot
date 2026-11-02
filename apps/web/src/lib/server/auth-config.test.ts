import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { androidCertFingerprints, passkeyOrigins } from "./auth-config";

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
