import { expect, test } from "./fixtures";
import pg from "pg";
import { MemoryService } from "../packages/memory/src/index";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

/** Remove only facts this test created; never clear or overwrite the owner's existing profile. */
async function cleanupFact(content: string) {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  });
  try {
    const { rows } = await pool.query<{ id: string; revision: number }>(
      "select id,revision from memory_items where bot_id is null and content=$1 and state<>'deleted'",
      [content],
    );
    const memory = new MemoryService(pool);
    for (const row of rows)
      await memory.forget({ id: row.id, expectedRevision: row.revision }, { kind: "user" });
  } finally {
    await pool.end();
  }
}

test("write a shared preference without replacing existing profile facts", async ({ page }) => {
  const fact = `E2E ${uniqueName("profile")}: I prefer vegetarian meals.`;
  try {
    await page.goto("/settings#about");
    const manager = page.getByTestId("memory-manager");
    await manager.getByRole("button", { name: "Add memory" }).click();
    await page.getByRole("textbox", { name: "Memory", exact: true }).fill(fact);
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(manager.getByTestId("memory-item").filter({ hasText: fact })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("memory-item").filter({ hasText: fact })).toBeVisible();
    await page.goto("/");
    await expect(page.getByText("Tell your teammates about you")).toHaveCount(0);
  } finally {
    await cleanupFact(fact);
  }
});

test("@agent a shared fact is recalled by a new teammate", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const fact = `E2E ${uniqueName("allergy")}: Vegetarian; allergic to peanuts.`;
  try {
    await createTeammate(page, uniqueName("Ann"), "travel planner");
    await sendMessage(
      page,
      `Please remember for all teammates this exact shared fact: ${fact} Then say done.`,
    );
    await waitForLastRun(page, ["completed"]);
    await page.goto("/settings#about");
    await expect(page.getByTestId("memory-item").filter({ hasText: fact })).toBeVisible();
    await createTeammate(page, uniqueName("Bob"), "personal chef");
    await sendMessage(
      page,
      "What am I allergic to? Recall saved memory and answer in a few words.",
    );
    await waitForLastRun(page, ["completed"]);
    await expect(page.getByTestId("run").last()).toContainText(/peanut/i);
  } finally {
    await cleanupFact(fact);
  }
});
