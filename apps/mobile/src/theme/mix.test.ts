import { describe, expect, it } from "vitest";
import { mix } from "./mix";

describe("mix", () => {
  it("blends like CSS color-mix in sRGB", () => {
    expect(mix("#ff0000", "#0000ff", 1)).toBe("#ff0000");
    expect(mix("#ff0000", "#0000ff", 0)).toBe("#0000ff");
    expect(mix("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mix("#fff", "#000", 0.16)).toBe("#292929");
  });
});
