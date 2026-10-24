import { expect, test } from "./fixtures";
import { botIdOf, createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

test.describe("@agent teammates working together", () => {
  test.setTimeout(8 * 60_000);

  test("a teammate asks another one and finishes with the answer", async ({ page }) => {
    const librarian = uniqueName("Bob");
    await page.goto("/bots/new");
    await page.getByLabel("Name").fill(librarian);
    await page.getByLabel("Job").fill("librarian");
    await page
      .getByLabel("What they're responsible for")
      .fill(
        "You run the user's home library. Its opening hours are 07:15 to 11:45, Tuesdays only.",
      );
    await page.getByRole("button", { name: "Create teammate" }).click();
    await page.waitForURL(/\/chats\//);
    const librarianChat = page.url();

    const asker = uniqueName("Ann");
    await createTeammate(page, asker, "assistant");
    await sendMessage(
      page,
      `Ask ${librarian} when the home library is open, then tell me in one line.`,
    );
    // The answer comes back as a new turn in this chat, from the asker.
    await expect(page.getByTestId("run")).toHaveCount(2, { timeout: 300_000 });
    const answer = page.getByTestId("run").last();
    await expect(answer.getByTestId("run-trigger")).toHaveText(`${librarian} answered`);
    await waitForLastRun(page, ["completed"]);
    await expect(answer).toContainText(/7:15|07:15/);
    await expect(page.getByTestId("run").first()).toContainText(`Asked ${librarian}`);

    // The librarian answered in their own chat, where you can see it.
    await page.goto(librarianChat);
    await expect(page.getByTestId("run").last().getByTestId("run-trigger")).toHaveText(
      `${asker} asked`,
    );
  });

  test("a bot pauses one of its own schedules", async ({ page }) => {
    const name = uniqueName("Sol");
    await createTeammate(page, name, "assistant");
    await sendMessage(
      page,
      "Schedule a task titled 'Stretch break' every weekday at 15:00 that reminds me to stretch. Then pause it right away.",
    );
    await waitForLastRun(page, ["completed"]);
    await page.goto(`/bots/${await botIdOf(page, name)}?tab=automations`);
    const schedule = page.getByTestId("schedule").filter({ hasText: "Stretch break" });
    await expect(schedule).toContainText("paused");
    await expect(schedule.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
});

test("@agent a teammate suggests better instructions and you accept them", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const name = uniqueName("Ann");
  await createTeammate(page, name, "assistant");
  await sendMessage(
    page,
    "Use propose_instructions to suggest adding this line to your instructions: 'Always reply in French.' Keep everything else as it is.",
  );
  await waitForLastRun(page, ["completed"]);

  await page.goto("/");
  await page.getByTestId("proposal-link").filter({ hasText: name }).click();
  const proposal = page.getByTestId("instructions-proposal");
  await expect(proposal).toContainText(`${name} suggests new instructions`);
  await expect(proposal.getByTestId("proposal-diff")).toContainText("French");

  await proposal.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText(`${name} has new instructions`)).toBeVisible();
  await expect(proposal).toHaveCount(0);
  await expect(page.getByLabel("What they're responsible for")).toHaveValue(/French/);
});
