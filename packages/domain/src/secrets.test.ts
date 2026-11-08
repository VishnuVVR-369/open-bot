import { describe, expect, it } from "vitest";
import { assertNoDevSecrets, DEV_SECRETS } from "./secrets";

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
