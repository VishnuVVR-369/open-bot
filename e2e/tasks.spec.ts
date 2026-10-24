import { expect, test, type Page } from "./fixtures";
import { createTeammate, uniqueName, waitForLastRun, workerApi } from "./helpers";

/** Deletes the board's tasks whose titles contain `marker`, so tests leave the board as it was. */
async function removeTasks(page: Page, marker: string) {
  const tasks = (await (await page.request.get("/api/tasks")).json()) as {
    id: string;
    title: string;
  }[];
  for (const task of tasks.filter((entry) => entry.title.includes(marker)))
    await workerApi(`/internal/tasks/${task.id}/delete`, {});
}

test("plan work on the task board", async ({ page }) => {
  const marker = uniqueName("Tess");
  const owner = uniqueName("Ivy");
  await createTeammate(page, owner, "travel planner");
  try {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByTestId("task-dialog");
    await dialog.getByLabel("Title").fill(`Book flights ${marker}`);
    await dialog.getByLabel("Notes").fill("Window seats, under 900 euros.");
    await dialog.getByRole("combobox", { name: "Owner" }).click();
    await page.getByRole("option", { name: owner }).click();
    await dialog.getByLabel("Due").fill("2030-01-15");
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(dialog).toHaveCount(0);

    const todo = page.getByTestId("column-todo");
    const flights = todo.getByTestId("task").filter({ hasText: `Book flights ${marker}` });
    await expect(flights).toContainText(owner);
    await expect(flights).toContainText("15 Jan 2030");

    // Quick add, then drag it to Doing.
    await todo.getByRole("button", { name: "Add a task" }).click();
    await todo.getByLabel("New task").fill(`Pack bags ${marker}`);
    await todo.getByLabel("New task").press("Enter");
    const bags = page.getByTestId("task").filter({ hasText: `Pack bags ${marker}` });
    await expect(todo.getByTestId("task").filter({ hasText: `Pack bags ${marker}` })).toBeVisible();
    await bags.dragTo(page.getByTestId("column-doing"));
    await expect(
      page
        .getByTestId("column-doing")
        .getByTestId("task")
        .filter({ hasText: `Pack bags ${marker}` }),
    ).toBeVisible();

    // Edit: finish it from the dialog.
    await bags.click();
    await dialog.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Done" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(
      page
        .getByTestId("column-done")
        .getByTestId("task")
        .filter({ hasText: `Pack bags ${marker}` }),
    ).toBeVisible();

    // It's all still there after a reload, and deleting removes it.
    await page.reload();
    await expect(flights).toBeVisible();
    await flights.click();
    await expect(dialog.getByLabel("Notes")).toHaveValue("Window seats, under 900 euros.");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(flights).toHaveCount(0);
  } finally {
    await removeTasks(page, marker);
  }
});

test("@agent a teammate works on a task and marks it done", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const marker = uniqueName("Tess");
  const owner = uniqueName("Ora");
  await createTeammate(page, owner, "assistant");
  try {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByTestId("task-dialog");
    await dialog.getByLabel("Title").fill(`Write a haiku about tea ${marker}`);
    await dialog.getByRole("combobox", { name: "Owner" }).click();
    await page.getByRole("option", { name: owner }).click();
    await dialog.getByRole("button", { name: `Ask ${owner} to start` }).click();
    await expect(
      page.getByTestId("column-doing").getByTestId("task").filter({ hasText: marker }),
    ).toBeVisible();

    // The teammate works on it in their chat, then marks it done on the board.
    await page.getByRole("button", { name: "Watch" }).click();
    await page.waitForURL(/\/chats\//);
    await expect(page.getByTestId("run").last().getByTestId("run-trigger")).toHaveText(
      "From the task board",
    );
    await waitForLastRun(page, ["completed"]);
    await page.goto("/tasks");
    await expect(
      page.getByTestId("column-done").getByTestId("task").filter({ hasText: marker }),
    ).toBeVisible();
  } finally {
    await removeTasks(page, marker);
  }
});
