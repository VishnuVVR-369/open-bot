import { describe, expect, it, vi } from "vitest";

vi.mock("expo-local-authentication", () => ({}));
vi.mock("react-native", () => ({}));
vi.mock("./preferences", () => ({ getPreferences: () => ({ appLock: true }) }));

const { RELOCK_AFTER_MS, shouldRelock } = await import("./lock");

describe("the fingerprint lock", () => {
  it("asks again only after five minutes in the background", () => {
    expect(shouldRelock(null, 10)).toBe(false);
    expect(shouldRelock(0, RELOCK_AFTER_MS - 1)).toBe(false);
    expect(shouldRelock(0, RELOCK_AFTER_MS)).toBe(true);
  });
});
