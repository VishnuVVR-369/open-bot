import { expect, test } from "./fixtures";
import pg from "pg";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

/** These tests change your real profile, so each puts back what was there. */
async function withProfile(run: () => Promise<void>) {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  });
  const { rows } = await pool.query<{ about_me: string; about_me_updated_at: Date | null }>(
    "select about_me, about_me_updated_at from settings where id = 1",
  );
  const saved = rows[0]!;
  try {
    await pool.query("update settings set about_me = '' where id = 1");
    await run();
  } finally {
    await pool.query("update settings set about_me = $1, about_me_updated_at = $2 where id = 1", [
      saved.about_me,
      saved.about_me_updated_at,
    ]);
    await pool.end();
  }
}

test("write the profile every teammate reads", async ({ page }) => {
  await withProfile(async () => {
    await createTeammate(page, uniqueName("Tess"));
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("open-bot:profile-nudge-dismissed"));
    await page.reload();
    await page.getByRole("link", { name: /Tell your teammates about you/ }).click();
    await expect(page).toHaveURL("/settings#about");

    const input = page.getByTestId("profile-input");
    await input.fill("I live in Lisbon.\n- Vegetarian");
    await expect(page.getByText("30 / 8,000")).toBeVisible();
    await page.locator("#about").getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("profile-input")).toHaveValue("I live in Lisbon.\n- Vegetarian");

    // With a profile, home stops asking for one.
    await page.goto("/");
    await expect(page.getByTestId("teammate-card").first()).toBeVisible();
    await expect(page.getByText("Tell your teammates about you")).toHaveCount(0);
  });
});

test("the home nudge can be dismissed", async ({ page }) => {
  await withProfile(async () => {
    await createTeammate(page, uniqueName("Tess"));
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("open-bot:profile-nudge-dismissed"));
    await page.reload();
    await expect(page.getByText("Tell your teammates about you")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Tell your teammates about you")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("teammate-card").first()).toBeVisible();
    await expect(page.getByText("Tell your teammates about you")).toHaveCount(0);
  });
});

test.describe("@agent a shared profile", () => {
  test.setTimeout(8 * 60_000);

  test("what one teammate learns about you, another one knows", async ({ page }) => {
    await withProfile(async () => {
      await createTeammate(page, uniqueName("Ann"), "travel planner");
      await sendMessage(
        page,
        "Please remember for all my teammates: I'm vegetarian and allergic to peanuts. Just add it to my profile, then say done.",
      );
      await waitForLastRun(page, ["completed"]);
      await expect(page.getByTestId("run").last()).toContainText("Added to your profile");
      await page.goto("/settings");
      await expect(page.getByTestId("profile-input")).toHaveValue(/peanut/i);

      await createTeammate(page, uniqueName("Bob"), "personal chef");
      await sendMessage(
        page,
        "Without asking me or searching anything, what am I allergic to? Answer in a few words.",
      );
      await waitForLastRun(page, ["completed"]);
      await expect(page.getByTestId("run").last()).toContainText(/peanut/i);
    });
  });
});
