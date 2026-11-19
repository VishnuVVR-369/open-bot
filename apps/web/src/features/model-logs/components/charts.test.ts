import { describe, expect, it } from "vitest";
import { axisTicks, labelStride, niceMax } from "./charts";

describe("chart axes", () => {
  it("rounds the top up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(180)).toBe(200);
    expect(niceMax(2_100)).toBe(2_500);
    expect(axisTicks(180)).toEqual([0, 50, 100, 150, 200]);
    // $0.05 in micros: steps of $0.02, never $0.0125 that would print as $0.01.
    expect(axisTicks(50_000)).toEqual([0, 20_000, 40_000, 60_000, 80_000]);
    expect(axisTicks(330_000)).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
    expect(axisTicks(0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("steps counts in whole numbers", () => {
    expect(axisTicks(1, true)).toEqual([0, 1, 2, 3, 4]);
    expect(axisTicks(3, true)).toEqual([0, 1, 2, 3, 4]);
    expect(axisTicks(7, true)).toEqual([0, 2, 4, 6, 8]);
    expect(axisTicks(13, true)).toEqual([0, 5, 10, 15, 20]);
    expect(axisTicks(40, true)).toEqual([0, 10, 20, 30, 40]);
    expect(axisTicks(0, true)).toEqual([0, 1, 2, 3, 4]);
    for (const max of [1, 2, 3, 5, 9, 13, 99, 250])
      for (const tick of axisTicks(max, true)) expect(Number.isInteger(tick)).toBe(true);
  });

  it("labels only as many columns as fit", () => {
    expect(labelStride(7, 900)).toBe(1);
    expect(labelStride(90, 830)).toBe(8);
    expect(labelStride(90, 250)).toBe(30);
    expect(labelStride(90, 10)).toBe(45);
  });
});
