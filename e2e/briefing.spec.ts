import { expect, test, type Page } from "./fixtures";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

/** Pretend you left the app `minutes` ago and come back to Home. */
async function comeBack(page: Page, minutes: number) {
  await page.evaluate((away) => {
    localStorage.removeItem("open-bot:briefing-since");
    localStorage.setItem("open-bot:last-active", String(Date.now() - away * 60_000));
  }, minutes);
  await page.goto("/");
}

test("no briefing after a short break", async ({ page }) => {
  await page.goto("/");
  await comeBack(page, 5);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("briefing")).toHaveCount(0);
});

test("@agent Home briefs you on what teammates did while you were away", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const name = uniqueName("Tess");
  await createTeammate(page, name);
  await sendMessage(page, "Reply with only the word kiwi.");
  await waitForLastRun(page, ["completed"]);

  await comeBack(page, 20);
  const briefing = page.getByTestId("briefing");
  await expect(briefing).toContainText("While you were away");
  const row = briefing.getByTestId("briefing-bot").filter({ hasText: name });
  await expect(row).toContainText("1 task");
  await row.getByRole("link", { name: /kiwi/i }).click();
  await page.waitForURL(/\/chats\/.+#run-/);

  // Dismissed, it stays gone.
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss the briefing" }).click();
  await expect(briefing).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(briefing).toHaveCount(0);
});
