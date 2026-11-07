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
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("explains how to get back in without a password", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Forgot password?" }).click();
    const dialog = page.getByRole("dialog", { name: "Forgot your password?" });
    await expect(dialog).toContainText("Settings, under Security");
    await expect(dialog).toContainText("pnpm owner:reset-password");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
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
    await form.getByLabel("New password again").fill("a-new-password-1");
    await form.getByRole("button", { name: "Change password" }).click();
    await expect(form.getByRole("alert")).toHaveText("That isn't your current password.");
  });

  test("checks the new password twice before sending it", async ({ page }) => {
    await page.goto("/settings#security");
    const form = page.getByTestId("change-password");
    await form.getByLabel("Current password").fill("whatever-it-is");
    await form.getByLabel("New password", { exact: true }).fill("a-new-password-1");
    await form.getByLabel("New password again").fill("a-new-password-2");
    await form.getByRole("button", { name: "Change password" }).click();
    await expect(form.getByRole("alert")).toHaveText("The new passwords don't match.");
  });
});
