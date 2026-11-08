import { describe, expect, it } from "vitest";
import {
  assertNoDevSecrets,
  decryptSecret,
  DEV_ENCRYPTION_KEY,
  DEV_SECRETS,
  encryptSecret,
  secretHint,
} from "./secrets";

describe("assertNoDevSecrets", () => {
  it("refuses the public development secrets in production", () => {
    expect(() =>
      assertNoDevSecrets(
        { WORKER_SECRET: DEV_SECRETS.WORKER_SECRET, ENCRYPTION_KEY: "a-real-key" },
        "production",
      ),
    ).toThrow(/WORKER_SECRET/);
    expect(() => assertNoDevSecrets({ ...DEV_SECRETS }, "production")).toThrow(
      /WORKER_SECRET, ENCRYPTION_KEY, BOTD_TOKEN/,
    );
  });

  it("allows real secrets in production and the defaults in development", () => {
    expect(() =>
      assertNoDevSecrets(
        { WORKER_SECRET: "a-real-secret", BOTD_TOKEN: "a-real-token" },
        "production",
      ),
    ).not.toThrow();
    expect(() => assertNoDevSecrets({ ...DEV_SECRETS }, "development")).not.toThrow();
    expect(() => assertNoDevSecrets({ ...DEV_SECRETS }, undefined)).not.toThrow();
  });
});

describe("encryptSecret", () => {
  it("encrypts secrets so they round-trip and can't be tampered with", () => {
    const sealed = encryptSecret("sk-test-1234567890", DEV_ENCRYPTION_KEY);
    expect(sealed).not.toContain("sk-test");
    expect(decryptSecret(sealed, DEV_ENCRYPTION_KEY)).toBe("sk-test-1234567890");
    const [iv, tag, data] = sealed.split(".");
    expect(() => decryptSecret([iv, tag, `${data}AA`].join("."), DEV_ENCRYPTION_KEY)).toThrow();
    expect(secretHint("sk-test-1234567890")).toBe("sk-…7890");
  });
});
