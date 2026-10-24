import { expect, test } from "./fixtures";
import { createTeammate, uniqueName } from "./helpers";

test("⌘K finds teammates and pages, and opens them", async ({ page }) => {
  const name = uniqueName("Tess");
  await createTeammate(page, name, "search tester");
  await page.goto("/");

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-input");
  await expect(input).toBeFocused();
  await input.fill(name.toLowerCase());
  await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole("option", { name: "Automations" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/chats\//);
  await expect(page.getByText(`Give ${name} something to do`)).toBeVisible();

  await page.getByTestId("open-search").click();
  await input.fill("sched");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/automations");
});
