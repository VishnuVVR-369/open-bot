import { expect, test } from "./fixtures";

test.describe("sign-in", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sends visitors to sign in", async ({ page }) => {
    await page.goto("/automations");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("rejects a wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("explains how to get back in without a password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: "Forgot password?" }).click();
    const dialog = page.getByRole("dialog", { name: "Forgot your password?" });
    await expect(dialog).toContainText("Use a passkey to reset your password");
    await expect(dialog).toContainText("you have 10 minutes to choose a new password");
    await expect(dialog.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Other ways" })).toBeVisible();
    await expect(dialog.getByTestId("command")).toHaveText(
      "pnpm owner:reset-password someone@example.com",
    );
    await expect(dialog.getByRole("button", { name: "Copy" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();
  });

  test("shows the password while typing on request", async ({ page }) => {
    await page.goto("/login");
    const password = page.getByLabel("Password", { exact: true });
    await password.fill("not-the-password");
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(password).toHaveAttribute("type", "password");
  });
});

test.describe("change password", () => {
  // Only the refusal is exercised: a wrong current password fails before anything is stored,
  // so the owner's real password and sessions stay as they are.
  test("refuses a wrong current password", async ({ page }) => {
    await page.goto("/settings#security");
    const form = page.getByTestId("change-password");
    await form.getByLabel("Current password").fill("not-the-current-password");
    await form.getByLabel("New password", { exact: true }).fill("a-new-password-1");
    await form.getByLabel("Confirm new password").fill("a-new-password-1");
    await form.getByRole("button", { name: "Change password" }).click();
    await expect(form.getByRole("alert")).toHaveText("That isn't your current password.");
  });

  test("won't set a new password without a fresh passkey sign-in", async ({ page }) => {
    await page.goto("/settings#security");
    const refused = await page.evaluate(async () => {
      const response = await fetch("/api/auth/passkey-reset/set-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: "a-new-password-1" }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("PASSKEY_REQUIRED");
  });

  test("checks the new password twice before sending it", async ({ page }) => {
    await page.goto("/settings#security");
    const form = page.getByTestId("change-password");
    await form.getByLabel("Current password").fill("whatever-it-is");
    await form.getByLabel("New password", { exact: true }).fill("a-new-password-1");
    await form.getByLabel("Confirm new password").fill("a-new-password-2");
    await form.getByRole("button", { name: "Change password" }).click();
    await expect(form.getByRole("alert")).toHaveText("The new passwords don't match.");
  });
});
