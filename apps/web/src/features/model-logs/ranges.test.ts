import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exportRangeHref,
  rangeBounds,
  rangeLabel,
  rangeOf,
  runFiltersOf,
  withRange,
} from "./ranges";

const UUID = "0b9a8f8e-2a3c-4c1d-9f00-3c1a2b3c4d5e";
// Days are the browser's; pin a zone with a daylight saving change in the ranges below.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  process.env.TZ = zone;
});

describe("model log ranges and filters in the address", () => {
  it("reads a preset, whole days, or any time, and writes them back", () => {
    const params = new URLSearchParams("range=7d&q=x");
    expect(rangeOf(params)).toEqual({ kind: "preset", id: "7d" });
    expect(rangeOf(new URLSearchParams("from=2026-11-01&to=nope"))).toEqual({
      kind: "days",
      from: "2026-11-01",
      to: null,
    });
    expect(rangeOf(new URLSearchParams("range=2y"))).toEqual({ kind: "any" });
    expect(rangeOf(new URLSearchParams(), "30d")).toEqual({ kind: "preset", id: "30d" });
    const written = withRange(params, { kind: "days", from: "2026-11-01", to: "2026-11-03" });
    expect(written.toString()).toBe("q=x&from=2026-11-01&to=2026-11-03");
    expect(withRange(written, { kind: "any" }).toString()).toBe("q=x");
  });

  it("turns a range into whole days in the browser's zone, across a clock change", () => {
    const today = new Date("2026-11-03T15:00:00-08:00");
    // Seven days ending today: Oct 28 (still on summer time) through the start of Nov 4.
    expect(rangeBounds({ kind: "preset", id: "7d" }, today)).toEqual({
      from: "2026-10-28T07:00:00.000Z",
      to: "2026-11-04T08:00:00.000Z",
    });
    expect(rangeBounds({ kind: "days", from: "2026-11-01", to: "2026-11-01" })).toEqual({
      from: "2026-11-01T07:00:00.000Z",
      to: "2026-11-02T08:00:00.000Z",
    });
    expect(rangeBounds({ kind: "days", from: null, to: "2026-11-01" })).toEqual({
      to: "2026-11-02T08:00:00.000Z",
    });
    expect(rangeBounds({ kind: "any" })).toEqual({});
    expect(rangeLabel({ kind: "days", from: "2026-11-01", to: "2026-11-03" })).toBe(
      "Nov 1 to Nov 3",
    );
    expect(rangeLabel({ kind: "days", from: null, to: "2026-11-03" })).toBe("Until Nov 3");
  });

  it("keeps only well-formed filters", () => {
    expect(
      runFiltersOf(
        new URLSearchParams(
          `teammate=${UUID}&chat=not-a-uuid&status=errors&access=api_key&model=gpt-5.5&q=%20dst%20`,
        ),
      ),
    ).toEqual({
      teammateId: UUID,
      status: "errors",
      access: "api_key",
      model: "gpt-5.5",
      q: "dst",
    });
    expect(runFiltersOf(new URLSearchParams("status=exploded&access=free&q=%20"))).toEqual({});
  });

  it("links an export to a range, and to nothing without one", () => {
    expect(exportRangeHref({})).toBeNull();
    expect(exportRangeHref({ from: "2026-11-01T07:00:00.000Z" })).toBe(
      "/api/model-logs/export?from=2026-11-01T07%3A00%3A00.000Z",
    );
  });
});
