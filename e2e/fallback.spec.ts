import { expect, test } from "./fixtures";
import pg from "pg";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
});

test.describe("when the plan runs out", () => {
  test.afterAll(async () => {
    await pool.query(
      "update settings set plan_limited_until = null, monthly_cap_micros = 20000000",
    );
    await pool.query("delete from credentials");
    await pool.end();
  });

  test("runs move to the API key while the plan is limited, up to the cap", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("OpenAI API key").fill("sk-not-a-real-key-for-open-bot-tests-1234");
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByText("sk-…1234")).toBeVisible();

    // Codex reports the plan's limit by failing a turn; simulate the state it leaves behind.
    await pool.query(
      "update settings set plan_limited_until = now() + interval '1 hour', monthly_cap_micros = 5000000",
    );
    await page.reload();
    await expect(page.getByTestId("fallback-status")).toContainText("Running on your API key");

    await createTeammate(page, uniqueName("Ava"));
    await sendMessage(page, "Reply with just: hello");
    await waitForLastRun(page, ["failed"], 120_000);
    const run = page.getByTestId("run").last();
    await expect(run).toContainText("API key");
    await expect(run).toContainText("Your OpenAI API key was rejected");

    await pool.query("update settings set monthly_cap_micros = 0");
    await sendMessage(page, "Reply with just: hello again");
    await waitForLastRun(page, ["failed"], 60_000);
    await expect(page.getByTestId("run").last()).toContainText("reached your $0.00 cap");
  });
});
