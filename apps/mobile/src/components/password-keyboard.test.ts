import { describe, expect, it } from "vitest";
import { passwordKeyboard } from "./password-keyboard";

describe("a password field's keyboard", () => {
  it("can't learn a password once it's shown", () => {
    expect(passwordKeyboard(undefined, true, true)).toBe("visible-password");
    expect(passwordKeyboard("default", true, true)).toBe("visible-password");
  });

  it("stays as asked while hidden, for other fields, and for a number pad", () => {
    expect(passwordKeyboard(undefined, true, false)).toBeUndefined();
    expect(passwordKeyboard("email-address", false, true)).toBe("email-address");
    expect(passwordKeyboard("number-pad", true, true)).toBe("number-pad");
  });
});
