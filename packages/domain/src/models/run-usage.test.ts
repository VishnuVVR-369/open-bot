import { describe, expect, it } from "vitest";
import { runUsage } from "./run-usage";

const plan = { inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 50, costMicros: 0 };
const apiKey = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 100, costMicros: 5_000 };
const none = { plan: null, api_key: null };

describe("a run's usage", () => {
  it("reads a run a current worker ran from its counted model requests", () => {
    const logs = { tokens: 3_200, costMicros: 5_100, estimated: false };
    expect(runUsage({ legacy: none, fromLogs: logs })).toEqual(logs);
  });

  it("keeps a logged run's own numbers even when they are zero", () => {
    // Every request was refused: logged, at no cost.
    const zero = { tokens: 0, costMicros: 0, estimated: false };
    expect(runUsage({ legacy: none, fromLogs: zero })).toEqual(zero);
  });

  it("adds up both access modes of a run a worker that wrote usage_entries ran", () => {
    expect(runUsage({ legacy: { plan, api_key: apiKey }, fromLogs: null })).toEqual({
      tokens: 1_000 + 50 + 2_000 + 100,
      costMicros: 5_000,
      estimated: false,
    });
    expect(runUsage({ legacy: { plan, api_key: null }, fromLogs: null })).toEqual({
      tokens: 1_050,
      costMicros: 0,
      estimated: false,
    });
  });

  it("adds both producers' parts, and says when any of it is estimated", () => {
    expect(
      runUsage({
        legacy: { plan, api_key: null },
        fromLogs: { tokens: 500, costMicros: 70, estimated: true },
      }),
    ).toEqual({ tokens: 1_550, costMicros: 70, estimated: true });
  });

  it("is null for a run with neither", () => {
    expect(runUsage({ legacy: none, fromLogs: null })).toBeNull();
  });
});
