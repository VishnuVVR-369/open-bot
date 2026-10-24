import { expect, test, type Page } from "./fixtures";
import { botIdOf, createTeammate, uniqueName, waitForLastRun } from "./helpers";

async function notificationsFor(page: Page, botId: string) {
  const all = (await (await page.request.get("/api/notifications")).json()) as {
    botId: string | null;
    runId: string | null;
    kind: string;
  }[];
  return all.filter((entry) => entry.botId === botId && entry.kind === "run_finished");
}

test("turn a teammate's daily check-in on and off", async ({ page }) => {
  const name = uniqueName("Sol");
  await createTeammate(page, name);
  await page.goto(`/bots/${await botIdOf(page, name)}?tab=automations`);
  const toggle = page.getByTestId("check-in").getByRole("switch", { name: "Daily check-in" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const row = page.getByTestId("schedule").filter({ hasText: "Daily check-in" });
  await expect(row).toContainText("Every day at 9:00 AM");
  await expect(row).toContainText("only news");

  // Off pauses it; on again resumes the same one.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("paused");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("schedule")).toHaveCount(1);
  await expect(row).not.toContainText("paused");

  // The schedule's own settings say it only speaks up for news.
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(
    page.getByRole("dialog").getByRole("switch", { name: "Only tell me when there's news" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("@agent a quiet routine stays quiet until there's news", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const name = uniqueName("Sol");
  await createTeammate(page, name);
  const botId = await botIdOf(page, name);
  const title = `E2E sweep ${Math.random().toString(36).slice(2, 6)}`;

  await page.goto(`/bots/${botId}?tab=automations`);
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByRole("menuitem", { name: "Schedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog
    .getByLabel("What to do")
    .fill("This is a test check, and today there is nothing the user needs to know.");
  await dialog.getByRole("switch", { name: "Only tell me when there's news" }).click();
  await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
  const row = page.getByTestId("schedule").filter({ hasText: title });
  await expect(row).toContainText("only news");

  // Nothing to report: one quiet line in the Scheduled chat, and no notification.
  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row).toContainText(/Last run|Running|Finished/, { timeout: 30_000 });
  const state = (await (await page.request.get("/api/state")).json()) as {
    chats: { id: string; kind: string; botId: string | null }[];
  };
  const scheduled = state.chats.find((chat) => chat.kind === "scheduled" && chat.botId === botId)!;
  await page.goto(`/chats/${scheduled.id}`);
  await waitForLastRun(page, ["completed"]);
  const quiet = page.getByTestId("run").last();
  await expect(quiet).toHaveAttribute("data-quiet");
  await expect(quiet).toContainText("Nothing to report");
  expect(await notificationsFor(page, botId)).toHaveLength(0);

  // News: a full reply, and a notification.
  await page.goto(`/bots/${botId}?tab=automations`);
  await row.getByRole("button", { name: "Edit" }).click();
  await dialog
    .getByLabel("What to do")
    .fill("This is a test check. Today the user needs to know one thing: the word MANGO.");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await row.getByRole("button", { name: "Run now" }).click();
  await page.goto(`/chats/${scheduled.id}`);
  await expect(page.getByTestId("run")).toHaveCount(2, { timeout: 30_000 });
  await waitForLastRun(page, ["completed"]);
  const news = page.getByTestId("run").last();
  await expect(news).not.toHaveAttribute("data-quiet");
  await expect(news).toContainText("MANGO");
  await expect.poll(async () => (await notificationsFor(page, botId)).length).toBe(1);
});
