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
        spendMicros: 0,
        capMicros: 0,
      }),
    ).toEqual({ mode: "plan" });
    expect(
      decideAuthMode({
        now: later,
        planLimitedUntil: now,
        hasApiKey: true,
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
        spendMicros: 5,
        capMicros: 10,
      }),
    ).toEqual({ mode: "api_key" });
    expect(
      decideAuthMode({
        now,
        planLimitedUntil: later,
        hasApiKey: true,
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
        spendMicros: 0,
        capMicros: 10,
      }),
    ).toEqual({
      mode: "blocked",
      reason: "no_key",
    });
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
