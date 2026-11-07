import { describe, expect, it } from "vitest";
import { newPasswordProblem, passwordChangeError, passwordChangeProblem } from "./password";

describe("passwordChangeProblem", () => {
  const good = { current: "old-password-1", next: "new-password-2", confirm: "new-password-2" };

  it("lets a sound change through", () => {
    expect(passwordChangeProblem(good)).toBeNull();
  });

  it.each([
    [{ ...good, current: "" }, "Enter your current password."],
    [
      { ...good, next: "short", confirm: "short" },
      "Use at least 10 characters for the new password.",
    ],
    [
      { ...good, next: "x".repeat(129), confirm: "x".repeat(129) },
      "Use at most 128 characters for the new password.",
    ],
    [{ ...good, confirm: "new-password-3" }, "The new passwords don't match."],
    [
      { current: "same-password", next: "same-password", confirm: "same-password" },
      "The new password is the same as the current one.",
    ],
  ])("%o", (input, expected) => {
    expect(passwordChangeProblem(input)).toBe(expected);
  });
});

describe("passwordChangeError", () => {
  it("names a wrong current password plainly", () => {
    expect(passwordChangeError("INVALID_PASSWORD")).toBe("That isn't your current password.");
  });

  it("falls back to a general line for anything else", () => {
    expect(passwordChangeError(undefined)).toBe("The password wasn't changed. Try again.");
  });
});

describe("newPasswordProblem", () => {
  it("needs no current password", () => {
    expect(newPasswordProblem({ next: "new-password-2", confirm: "new-password-2" })).toBeNull();
  });

  it("still checks length and the second copy", () => {
    expect(newPasswordProblem({ next: "short", confirm: "short" })).toBe(
      "Use at least 10 characters for the new password.",
    );
    expect(newPasswordProblem({ next: "new-password-2", confirm: "new-password-3" })).toBe(
      "The new passwords don't match.",
    );
  });
});
