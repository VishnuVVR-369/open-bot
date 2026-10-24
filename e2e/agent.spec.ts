import { expect, test } from "./fixtures";
import { botIdOf, createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

// These drive a real bot on the computer: slow, and they use your ChatGPT plan.
test.describe("@agent bots at work", () => {
  test.setTimeout(10 * 60_000);

  test("a bot uses the desktop, you take over mid-task, and it carries on", async ({ page }) => {
    await createTeammate(page, uniqueName("Ivy"), "research assistant");
    await sendMessage(
      page,
      "Open en.wikipedia.org/wiki/Grace_Hopper in the browser, scroll through the article, and tell me in one line what she is known for.",
    );
    const screen = page.getByTestId("computer-screen");
    await expect(screen).toHaveAttribute("data-activity", "working", { timeout: 180_000 });

    await page.getByTestId("take-over").click();
    await expect(screen).toHaveAttribute("data-activity", "you");
    await page.getByTestId("hand-back").click();
    await page.getByTestId("hand-back-note").fill("I just looked. Carry on.");
    await page.getByTestId("hand-back-confirm").click();

    await waitForLastRun(page, ["completed"]);
    await expect(
      page
        .getByTestId("run")
        .last()
        .getByText(/Grace Hopper|compiler|COBOL/i)
        .first(),
    ).toBeVisible();

    // Replay what it did on the desktop, frame by frame.
    const run = page.getByTestId("run").first();
    const steps = run.getByRole("button", { name: /^Show \d+ steps?$/ });
    if (await steps.isVisible()) await steps.click();
    await run.getByTestId("replay").first().click();
    const viewer = page.getByTestId("replay-viewer");
    await expect(viewer.getByRole("heading")).toContainText(/1 \/ \d+/);
    await expect(viewer.getByRole("heading")).toContainText(/2 \/ \d+/, { timeout: 5_000 });
    // Stepping back by hand stops the replay there.
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.getByRole("heading")).toContainText(/1 \/ \d+/);
    await expect(viewer.getByRole("button", { name: "Play the replay" })).toBeVisible();
  });

  test("a risky action waits for your approval", async ({ page }) => {
    await createTeammate(page, uniqueName("Ora"), "file clerk");
    await sendMessage(
      page,
      "Create the file /home/bot/shared/e2e-delete-me.txt with the text 'bye', then delete it. Deleting needs my approval.",
    );
    await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 180_000 });
    await page.getByTestId("approve").click();
    await waitForLastRun(page, ["completed"]);
  });

  test("always allowing a command stops the bot asking about it", async ({ page }) => {
    const name = uniqueName("Alw");
    await createTeammate(page, name, "assistant", "Ask before every command");
    await sendMessage(
      page,
      "Run the shell command `date -u` on its own and tell me what it printed.",
    );
    const card = page.getByTestId("approval-card").first();
    await expect(card).toBeVisible({ timeout: 180_000 });
    await expect(card).toContainText("date -u");
    await card.getByTestId("always-allow").click();
    await expect(page.getByTestId("always-allow-pattern")).toHaveValue("date -u");
    await page.getByTestId("always-allow-pattern").fill("date");
    await page.getByTestId("always-allow-confirm").click();
    await waitForLastRun(page, ["completed"]);

    const asked = await page.getByTestId("approval-card").count();
    await sendMessage(page, "Run `date +%Y` on its own and tell me the year it printed.");
    await waitForLastRun(page, ["completed"]);
    await expect(page.getByTestId("approval-card")).toHaveCount(asked);
    await expect(page.getByTestId("run").last()).toContainText(String(new Date().getUTCFullYear()));

    await page.goto(`/bots/${await botIdOf(page, name)}`);
    const rule = page.getByTestId("allowed-rule");
    await expect(rule).toHaveCount(1);
    await expect(rule).toContainText("Commands starting with date");
    await rule.getByRole("button", { name: "Ask me again" }).click();
    await expect(rule).toHaveCount(0);
  });

  test("stop a bot, try again, and copy the reply", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await createTeammate(page, uniqueName("Tess"), "assistant");
    await sendMessage(page, "Count from 1 to 3, one number per line, and nothing else.");
    await page.getByRole("button", { name: "Stop" }).click();
    await waitForLastRun(page, ["interrupted"]);

    await page.getByTestId("retry-run").click();
    await expect(page.getByTestId("run")).toHaveCount(2);
    await waitForLastRun(page, ["completed"]);
    // The stopped run has been tried again, so it no longer offers to.
    await expect(page.getByTestId("retry-run")).toHaveCount(0);

    const reply = page.getByTestId("run").last();
    await reply.hover();
    await reply.getByRole("button", { name: "Copy reply" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /1\s*\n\s*2\s*\n\s*3/,
    );
  });

  test("a bot schedules a task that runs and reports back", async ({ page }) => {
    await createTeammate(page, uniqueName("Sol"), "assistant");
    await sendMessage(
      page,
      "Schedule a one-time task 1 minute from now titled 'E2E ping' that just replies 'pong'.",
    );
    await waitForLastRun(page, ["completed"]);
    await page.goto("/automations");
    await expect(page.getByTestId("schedule").filter({ hasText: "E2E ping" })).toBeVisible();
    await expect(page.getByTestId("schedule").filter({ hasText: "E2E ping" })).toContainText(
      "done",
      { timeout: 180_000 },
    );
  });
});
