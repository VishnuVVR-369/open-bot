import { expect, test } from "./fixtures";
import { createTeammate, uniqueName } from "./helpers";

test("save a skill and pick it from the composer with /", async ({ page }) => {
  const name = `e2e-${Math.random().toString(36).slice(2, 7)}`;
  await page.goto("/skills");
  await page.getByTestId("new-skill").click();
  await page.getByTestId("skill-name").pressSequentially(name.replace(/-/g, " "));
  await expect(page.getByTestId("skill-name")).toHaveValue(name);
  await page.getByTestId("skill-description").fill("An end-to-end test skill");
  await page.getByTestId("skill-instructions").fill("Reply with the word ok.");
  await page.getByTestId("save-skill").click();
  const card = page.getByTestId("skill").filter({ hasText: `/${name}` });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Every teammate");

  // Any teammate's composer offers it after a slash, and picking it fills in the name.
  await createTeammate(page, uniqueName("Ava"));
  const input = page.getByTestId("composer-input");
  await input.click();
  await page.keyboard.type(`/${name.slice(0, 6)}`);
  await expect(page.getByTestId("skill-menu")).toContainText(`/${name}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("now");
  await expect(input).toHaveValue(`/${name} now`);
  await input.fill("");

  await page.goto("/skills");
  await card.hover();
  await card.getByRole("button", { name: `Delete /${name}` }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toHaveCount(0);
});
