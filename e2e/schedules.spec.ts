import { expect, test } from "./fixtures";
import { createTeammate, uniqueName } from "./helpers";

test("create, edit and delete a schedule", async ({ page }) => {
  const name = uniqueName("Tess");
  await createTeammate(page, name);
  const title = `E2E digest ${Math.random().toString(36).slice(2, 6)}`;

  await page.goto("/automations");
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByRole("menuitem", { name: "Schedule" }).click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("What to do").fill("Send me a short digest.");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const row = page.getByTestId("schedule").filter({ hasText: title });
  await expect(row).toContainText("Weekdays at");

  // Editing opens with what the schedule already says, and keeps it in sync.
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Title")).toHaveValue(title);
  await expect(page.getByLabel("What to do")).toHaveValue("Send me a short digest.");
  await page.getByRole("dialog").getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Every week" }).click();
  await page.getByRole("dialog").getByRole("combobox").nth(2).click();
  await page.getByRole("option", { name: "Friday" }).click();
  await page.getByLabel("What to do").fill("Send me a short weekly digest.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Every Friday at");

  await row.getByTestId("schedule-toggle").click();
  await expect(row).toContainText("Send me a short weekly digest.");
  await expect(row).toContainText("It hasn't run yet.");

  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});
