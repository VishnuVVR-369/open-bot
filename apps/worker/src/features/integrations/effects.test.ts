import type { ActionEffect } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import { approvalFor } from "./effects";

const ask = (
  effect: ActionEffect,
  autonomy: string,
  options: Partial<{
    askBeforeActing: boolean;
    readOutsideData: boolean;
    coveredByRule: boolean;
  }> = {},
) =>
  approvalFor({
    effect,
    autonomy,
    askBeforeActing: options.askBeforeActing ?? true,
    readOutsideData: options.readOutsideData ?? false,
    coveredByRule: options.coveredByRule ?? false,
  });

describe("whether an account action asks you", () => {
  it("never asks about reads", () => {
    for (const autonomy of ["full", "risky", "everything"])
      expect(ask("read", autonomy)).toBeNull();
  });

  it("asks about private writes only when the teammate asks about everything", () => {
    expect(ask("private_write", "full")).toBeNull();
    expect(ask("private_write", "risky")).toBeNull();
    expect(ask("private_write", "everything")).toBe("account_write");
  });

  it("follows autonomy and Always allow for writes", () => {
    expect(ask("write", "full")).toBeNull();
    expect(ask("write", "risky")).toBe("account_write");
    expect(ask("write", "risky", { coveredByRule: true })).toBeNull();
    // A teammate that asks about everything asks, rule or not.
    expect(ask("write", "everything", { coveredByRule: true })).toBe("account_write");
  });

  it("always asks before acting as you, unless you said not to and nothing outside could have steered it", () => {
    expect(ask("outward", "risky", { askBeforeActing: false })).toBe("account_outward");
    expect(ask("outward", "everything", { askBeforeActing: false })).toBe("account_outward");
    expect(ask("outward", "full")).toBe("account_outward");
    expect(ask("outward", "full", { askBeforeActing: false })).toBeNull();
    expect(ask("outward", "full", { askBeforeActing: false, readOutsideData: true })).toBe(
      "account_outward",
    );
    // Rules never cover acting as you.
    expect(ask("outward", "risky", { coveredByRule: true })).toBe("account_outward");
  });
});
