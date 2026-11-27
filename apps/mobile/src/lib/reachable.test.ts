import { describe, expect, it } from "vitest";
import { reachable } from "./reachable";

describe("whether the phone is online", () => {
  it("is offline only when the phone says so", () => {
    expect(reachable({ isConnected: true, isInternetReachable: true })).toBe(true);
    expect(reachable({})).toBe(true);
    expect(reachable({ isConnected: null, isInternetReachable: null })).toBe(true);
    expect(reachable({ isConnected: false })).toBe(false);
    expect(reachable({ isConnected: true, isInternetReachable: false })).toBe(false);
  });
});
