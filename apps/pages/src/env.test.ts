import { describe, expect, it } from "vitest";
import { readEnv } from "./env";

const SECRET = "a-real-pages-secret-of-32-characters!";

describe("readEnv", () => {
  it("has a development default for everything outside production", () => {
    const env = readEnv({ PAGE_LIB_DIR: "/lib" });
    expect(env).toMatchObject({
      databaseUrl: "postgres://openbot:openbot@127.0.0.1:54329/openbot",
      port: 3400,
      origin: "http://127.0.0.1:3400",
      appOrigins: ["http://localhost:3000"],
      libDir: "/lib",
    });
    expect(env.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses to start in production without PAGES_SECRET", () => {
    expect(() => readEnv({ NODE_ENV: "production", PAGE_LIB_DIR: "/lib" })).toThrow(
      /PAGES_SECRET must be set/,
    );
    expect(
      readEnv({ NODE_ENV: "production", PAGES_SECRET: SECRET, PAGE_LIB_DIR: "/lib" }).secret,
    ).toBe(SECRET);
  });

  it("takes its origin from PAGES_URL, or Railway's public domain", () => {
    expect(readEnv({ PAGES_URL: "https://pages.test//", PAGE_LIB_DIR: "/lib" }).origin).toBe(
      "https://pages.test",
    );
    expect(
      readEnv({ RAILWAY_PUBLIC_DOMAIN: "pages.up.railway.app", PAGE_LIB_DIR: "/lib" }).origin,
    ).toBe("https://pages.up.railway.app");
    expect(readEnv({ PORT: "3401", PAGE_LIB_DIR: "/lib" }).origin).toBe("http://127.0.0.1:3401");
  });

  it("reads APP_URL as a list of origins", () => {
    expect(
      readEnv({ APP_URL: "https://app.test/path, http://localhost:3000", PAGE_LIB_DIR: "/lib" })
        .appOrigins,
    ).toEqual(["https://app.test", "http://localhost:3000"]);
  });

  it("names an invalid setting", () => {
    expect(() => readEnv({ PORT: "eighty", PAGE_LIB_DIR: "/lib" })).toThrow(/^PORT: /);
  });
});
