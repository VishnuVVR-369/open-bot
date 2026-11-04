import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("react-native", () => ({ AppState: {} }));

import { AWAY_MS, dismiss, touch } from "./presence";

describe("presence", () => {
  const start = 1_000_000;

  it("doesn't brief you the first time, or after a short break", () => {
    const first = touch({ lastActive: null, awaySince: null }, start);
    expect(first).toEqual({ lastActive: start, awaySince: null });
    expect(touch(first, start + AWAY_MS - 1).awaySince).toBeNull();
  });

  it("briefs you from when you left, after a while away", () => {
    const back = touch({ lastActive: start, awaySince: null }, start + AWAY_MS);
    expect(back).toEqual({ lastActive: start + AWAY_MS, awaySince: start });
    // It stays while you're here, until you dismiss it.
    expect(touch(back, start + AWAY_MS + 30_000).awaySince).toBe(start);
    expect(dismiss(back).awaySince).toBeNull();
  });

  it("starts a new briefing from the latest time you left", () => {
    const back = touch({ lastActive: start, awaySince: null }, start + AWAY_MS);
    const later = start + 3 * AWAY_MS;
    expect(touch(back, later).awaySince).toBe(start + AWAY_MS);
  });
});
