import { describe, expect, it } from "vitest";
import { FOLDED_LINES, folds, mightFold } from "./fold";

describe("folds", () => {
  it("leaves a message that would hide only a few lines open", () => {
    expect(folds(FOLDED_LINES)).toBe(false);
    expect(folds(FOLDED_LINES + 3)).toBe(false);
  });

  it("folds a message that hides at least four lines", () => {
    expect(folds(FOLDED_LINES + 4)).toBe(true);
    expect(folds(40)).toBe(true);
  });
});

describe("mightFold", () => {
  it("skips short messages", () => {
    expect(mightFold("Thanks! Also add a weekly digest on Fridays.")).toBe(false);
    expect(mightFold("one\ntwo\nthree")).toBe(false);
  });

  it("measures messages with many lines", () => {
    expect(mightFold(Array.from({ length: 12 }, (_, i) => `Point ${i}`).join("\n"))).toBe(true);
  });

  it("measures a long paragraph, which a narrow screen wraps onto many lines", () => {
    expect(mightFold("word ".repeat(40))).toBe(true);
  });

  it("counts blank lines, which take a line each", () => {
    expect(mightFold("a" + "\n".repeat(11) + "b")).toBe(true);
  });
});
