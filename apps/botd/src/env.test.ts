import { describe, expect, it } from "vitest";
import { readEnv } from "./env";

const TOKEN = "a-botd-token-of-some-length";

describe("readEnv", () => {
  it("requires BOTD_TOKEN of at least 16 characters", () => {
    expect(() => readEnv({})).toThrow("BOTD_TOKEN: set it to at least 16 characters");
    expect(() => readEnv({ BOTD_TOKEN: "short" })).toThrow(
      "BOTD_TOKEN: set it to at least 16 characters",
    );
  });

  it("refuses the public development token in production", () => {
    const dev = "dev-botd-token-change-me";
    expect(() => readEnv({ BOTD_TOKEN: dev, NODE_ENV: "production" })).toThrow(
      /Set BOTD_TOKEN in production/,
    );
    expect(readEnv({ BOTD_TOKEN: dev }).token).toBe(dev);
    expect(readEnv({ BOTD_TOKEN: TOKEN, NODE_ENV: "production" }).token).toBe(TOKEN);
  });

  it("lowers the screen defaults when the lifecycle is on", () => {
    expect(readEnv({ BOTD_TOKEN: TOKEN })).toMatchObject({
      lifecycleEnabled: false,
      maxScreens: 4,
      screenIdleMs: 20 * 60_000,
      sharedGid: null,
      applyGuardExtraDomains: [],
      pageLibDir: "/opt/page-kit/lib",
    });
    expect(readEnv({ BOTD_TOKEN: TOKEN, COMPUTER_LIFECYCLE_ENABLED: "true" })).toMatchObject({
      lifecycleEnabled: true,
      maxScreens: 2,
      screenIdleMs: 3 * 60_000,
    });
  });

  it("reads the screen limits, the group and the apply guard's extra domains", () => {
    expect(
      readEnv({
        BOTD_TOKEN: TOKEN,
        MAX_SCREENS: "6",
        SCREEN_IDLE_MINUTES: "0.5",
        BOTS_GID: "1100", // vocabulary: allow
        APPLY_GUARD_EXTRA_DOMAINS: " host.docker.internal, ,portal.test ",
      }),
    ).toMatchObject({
      maxScreens: 6,
      screenIdleMs: 30_000,
      sharedGid: 1100,
      applyGuardExtraDomains: ["host.docker.internal", "portal.test"],
    });
  });

  it("lets an unused screen stop at the next sweep", () => {
    expect(readEnv({ BOTD_TOKEN: TOKEN, SCREEN_IDLE_MINUTES: "0" }).screenIdleMs).toBe(0);
    expect(() => readEnv({ BOTD_TOKEN: TOKEN, SCREEN_IDLE_MINUTES: "-1" })).toThrow(
      /^SCREEN_IDLE_MINUTES: /,
    );
  });

  it("refuses a screen limit that isn't a positive number", () => {
    expect(() => readEnv({ BOTD_TOKEN: TOKEN, MAX_SCREENS: "lots" })).toThrow(/^MAX_SCREENS: /);
    expect(() => readEnv({ BOTD_TOKEN: TOKEN, MAX_SCREENS: "0" })).toThrow(/^MAX_SCREENS: /);
  });
});
