import { afterEach, describe, expect, it, vi } from "vitest";

const REAL = {
  WORKER_SECRET: "a-real-worker-secret-0123456789",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  PAGES_SECRET: "a-real-pages-secret-of-at-least-32-chars",
  BETTER_AUTH_SECRET: "a-real-sign-in-secret-0123456789abcdef",
};

/** `checkProductionSecrets` as a server started with `vars` would run it. */
async function checkWith(
  vars: Record<string, string | undefined>,
  nodeEnv: "production" | "development" = "production",
) {
  vi.resetModules();
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  const { checkProductionSecrets } = await import("./env");
  return () => checkProductionSecrets(nodeEnv);
}

afterEach(() => vi.unstubAllEnvs());

describe("checkProductionSecrets", () => {
  it("starts in production with real secrets", async () => {
    expect(await checkWith(REAL)).not.toThrow();
  });

  it("refuses the public development secrets in production", async () => {
    expect(await checkWith({ ...REAL, PAGES_SECRET: undefined })).toThrow(/Set PAGES_SECRET/);
    expect(await checkWith({ ...REAL, WORKER_SECRET: undefined })).toThrow(/Set WORKER_SECRET/);
    expect(
      await checkWith({ ...REAL, BETTER_AUTH_SECRET: "change-me-to-a-long-random-string" }),
    ).toThrow(/Set BETTER_AUTH_SECRET/);
  });

  it("refuses a pages secret the pages service would refuse", async () => {
    expect(await checkWith({ ...REAL, PAGES_SECRET: "too-short" })).toThrow(
      /PAGES_SECRET to at least 32 characters/,
    );
  });

  it("allows the development secrets outside production", async () => {
    expect(await checkWith({}, "development")).not.toThrow();
  });
});
