import { describe, expect, it } from "vitest";
import { costMicros, decideAuthMode, formatDollars } from "./access";

const now = new Date("2026-10-14T10:00:00Z");
const later = new Date("2026-10-14T12:00:00Z");

describe("model access", () => {
  it("uses the plan unless it is limited", () => {
    expect(
      decideAuthMode({
        now,
        planLimitedUntil: null,
        hasApiKey: false,
        fallbackOff: null,
        spendMicros: 0,
        capMicros: 0,
      }),
    ).toEqual({ mode: "plan" });
    expect(
      decideAuthMode({
        now: later,
        planLimitedUntil: now,
        hasApiKey: true,
        fallbackOff: null,
        spendMicros: 0,
        capMicros: 1,
      }),
    ).toEqual({ mode: "plan" });
  });

  it("falls back to the API key while the plan is limited and under the cap", () => {
    expect(
      decideAuthMode({
        now,
        planLimitedUntil: later,
        hasApiKey: true,
        fallbackOff: null,
        spendMicros: 5,
        capMicros: 10,
      }),
    ).toEqual({ mode: "api_key" });
    expect(
      decideAuthMode({
        now,
        planLimitedUntil: later,
        hasApiKey: true,
        fallbackOff: null,
        spendMicros: 10,
        capMicros: 10,
      }),
    ).toEqual({
      mode: "blocked",
      reason: "cap_reached",
    });
    expect(
      decideAuthMode({
        now,
        planLimitedUntil: later,
        hasApiKey: false,
        fallbackOff: null,
        spendMicros: 0,
        capMicros: 10,
      }),
    ).toEqual({
      mode: "blocked",
      reason: "no_key",
    });
  });

  it("never picks the API key while model logging is off", () => {
    const limited = {
      now,
      planLimitedUntil: later,
      fallbackOff: "logging_off" as const,
      capMicros: 10,
    };
    expect(decideAuthMode({ ...limited, hasApiKey: true, spendMicros: 0 })).toEqual({
      mode: "blocked",
      reason: "logging_off",
    });
    // Adding a key wouldn't help, so that isn't what the run is told.
    expect(decideAuthMode({ ...limited, hasApiKey: false, spendMicros: 0 })).toEqual({
      mode: "blocked",
      reason: "logging_off",
    });
    // The plan itself is unaffected.
    expect(
      decideAuthMode({ ...limited, planLimitedUntil: null, hasApiKey: true, spendMicros: 0 }),
    ).toEqual({ mode: "plan" });
  });

  it("keeps the key off, with its own reason, while its spend can't be counted", () => {
    const limited = {
      now,
      planLimitedUntil: later,
      hasApiKey: true,
      spendMicros: 0,
      capMicros: 10,
    };
    expect(decideAuthMode({ ...limited, fallbackOff: "logs_unsaved" })).toEqual({
      mode: "blocked",
      reason: "logs_unsaved",
    });
    expect(decideAuthMode({ ...limited, fallbackOff: null })).toEqual({ mode: "api_key" });
  });

  it("prices tokens at list prices", () => {
    // 1M uncached input at $2, 1M cached at $0.10, 100k output at $10/M = $3.10.
    expect(
      costMicros({ inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBe(3_100_000);
    expect(formatDollars(3_100_000)).toBe("$3.10");
    expect(formatDollars(20_000_000)).toBe("$20");
  });
});
