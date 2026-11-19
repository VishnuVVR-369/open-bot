import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  bucketFor,
  cacheShare,
  capMonthLabel,
  EMPTY_USAGE,
  fillBuckets,
  planWindowLabel,
  planWindowReading,
  planWindowStep,
  sumUsage,
  weekOf,
} from "./usage";

describe("buckets", () => {
  it("shows up to about three months by day, and longer ranges by week", () => {
    const from = new Date("2026-08-01T00:00:00Z");
    expect(bucketFor(from, new Date("2026-10-31T00:00:00Z"))).toBe("day");
    expect(bucketFor(from, new Date("2026-11-17T00:00:00Z"))).toBe("week");
  });

  it("reads the plan's windows by hour over a few days, and by day's peak beyond", () => {
    const from = new Date("2026-11-10T00:00:00Z");
    expect(planWindowStep(from, new Date("2026-11-13T00:00:00Z"))).toBe("hour");
    expect(planWindowStep(from, new Date("2026-11-13T00:00:01Z"))).toBe("day");
  });

  it("steps days across months and years", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("puts a day in the week that starts on its Monday", () => {
    expect(weekOf("2026-11-17")).toBe("2026-11-16"); // a Tuesday
    expect(weekOf("2026-11-16")).toBe("2026-11-16");
    expect(weekOf("2026-11-22")).toBe("2026-11-16"); // a Sunday
  });

  it("fills quiet days with zeros, in order", () => {
    const rows = [
      { bucket: "2026-11-02", value: 5 },
      { bucket: "2026-11-04", value: 7 },
    ];
    const filled = fillBuckets(rows, "2026-11-01", "2026-11-05", "day", (bucket) => ({
      bucket,
      value: 0,
    }));
    expect(filled.map((row) => [row.bucket, row.value])).toEqual([
      ["2026-11-01", 0],
      ["2026-11-02", 5],
      ["2026-11-03", 0],
      ["2026-11-04", 7],
      ["2026-11-05", 0],
    ]);
  });

  it("fills weeks from the week of the first day to the week of the last", () => {
    const filled = fillBuckets([], "2026-11-04", "2026-11-17", "week", (bucket) => ({ bucket }));
    expect(filled.map((row) => row.bucket)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });
});

describe("totals", () => {
  it("adds every number", () => {
    const one = { ...EMPTY_USAGE, requests: 1, inputTokens: 100, cachedInputTokens: 80, errors: 1 };
    const two = { ...EMPTY_USAGE, requests: 2, inputTokens: 300, costMicros: 5, outputTokens: 9 };
    expect(sumUsage([one, two])).toEqual({
      ...EMPTY_USAGE,
      requests: 3,
      inputTokens: 400,
      cachedInputTokens: 80,
      outputTokens: 9,
      costMicros: 5,
      errors: 1,
    });
  });

  it("gives the cache share of input, or none without input", () => {
    expect(cacheShare({ inputTokens: 400, cachedInputTokens: 300 })).toBe(0.75);
    expect(cacheShare({ inputTokens: 0, cachedInputTokens: 0 })).toBeNull();
    expect(cacheShare({ inputTokens: 10, cachedInputTokens: 20 })).toBe(1);
  });
});

describe("plan windows", () => {
  it("reads a window from the rate-limit headers", () => {
    const headers = {
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "130",
    };
    expect(planWindowReading(headers, "primary")).toEqual({
      usedPercent: 42.5,
      windowMinutes: 300,
    });
    expect(planWindowReading(headers, "secondary")).toEqual({
      usedPercent: 100,
      windowMinutes: null,
    });
    expect(planWindowReading({ "x-codex-primary-used-percent": "n/a" }, "primary")).toBeNull();
    expect(planWindowReading(null, "primary")).toBeNull();
  });

  it("names windows in words", () => {
    expect(planWindowLabel(300, "primary")).toBe("5-hour window");
    expect(planWindowLabel(10_080, "secondary")).toBe("Weekly window");
    expect(planWindowLabel(45, "primary")).toBe("45-minute window");
    expect(planWindowLabel(null, "secondary")).toBe("Long window");
  });
});

describe("capMonthLabel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the UTC month the cap counts, whatever the zone it is read in", () => {
    // West of UTC, the month's first moment is still the last evening of the month before.
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(capMonthLabel("2026-11-01T00:00:00.000Z")).toBe("November (UTC)");
    expect(capMonthLabel(new Date("2026-01-01T00:00:00.000Z"))).toBe("January (UTC)");
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(capMonthLabel("2026-12-01T00:00:00.000Z")).toBe("December (UTC)");
  });
});
