import pg from "pg";
import { expect, test, type Page } from "./fixtures";
import {
  apiFor,
  createTeammate,
  e2eStack,
  teammateIdOf,
  uniqueName,
  waitForLastRun,
  worker,
} from "./helpers";

const db = new pg.Pool({ connectionString: e2eStack().databaseUrl, max: 2 });
test.afterAll(() => db.end());

/** How many times the task's owner was asked to work on it. */
async function asks(taskId: string) {
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from runs where task_id = $1",
    [taskId],
  );
  return rows[0]!.count;
}

/** Deletes the board's tasks whose titles contain `marker`, so tests leave the board as it was. */
async function removeTasks(page: Page, marker: string) {
  const tasks = await apiFor(page).tasks.list();
  for (const task of tasks.filter((entry) => entry.title.includes(marker)))
    await worker.tasks.remove({ taskId: task.id });
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
    await expect(flights).toContainText("Jan 15, 2030");

    // Quick add, then drag it to Doing.
    await todo.getByRole("button", { name: "Add a task" }).click();
    await todo.getByLabel("New task").fill(`Pack bags ${marker}`);
    await todo.getByLabel("New task").press("Enter");
    const bags = page.getByTestId("task").filter({ hasText: `Pack bags ${marker}` });
    await expect(todo.getByTestId("task").filter({ hasText: `Pack bags ${marker}` })).toBeVisible();

    // Dropped on a card, a task goes just before it, and stays there after a reload.
    const order = () =>
      todo
        .getByTestId("task")
        .filter({ hasText: marker })
        .evaluateAll((cards) => cards.map((card) => card.textContent ?? ""));
    await expect
      .poll(async () => (await order()).map((text) => text.slice(0, 9)))
      .toEqual(["Book flig", "Pack bags"]);
    await bags.dragTo(flights);
    await expect
      .poll(async () => (await order()).map((text) => text.slice(0, 9)))
      .toEqual(["Pack bags", "Book flig"]);
    await page.reload();
    await expect
      .poll(async () => (await order()).map((text) => text.slice(0, 9)))
      .toEqual(["Pack bags", "Book flig"]);

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

test("a start whose answer is lost adds the task once and asks once", async ({ page }) => {
  const marker = uniqueName("Tess");
  const owner = uniqueName("Ivy");
  await createTeammate(page, owner, "travel planner");
  try {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByTestId("task-dialog");
    await dialog.getByLabel("Title").fill(`Renew passports ${marker}`);
    await dialog.getByRole("combobox", { name: "Owner" }).click();
    await page.getByRole("option", { name: owner }).click();
    // The start reaches the server, which asks the teammate, but its answer never arrives.
    let lost = 0;
    await page.route("**/api/rpc/tasks/start", async (route) => {
      await route.fetch();
      lost++;
      await route.abort("connectionreset");
    });
    await dialog.getByRole("button", { name: `Ask ${owner} to start` }).click();
    await expect(page.getByText("Couldn't start it")).toBeVisible();
    expect(lost).toBe(1);
    await page.unroute("**/api/rpc/tasks/start");

    // Trying again from the same dialog: the task isn't added again, and the teammate isn't
    // asked again.
    await expect(dialog.getByRole("heading", { name: "Task" })).toBeVisible();
    await dialog.getByRole("button", { name: `Ask ${owner} to start` }).click();
    await expect(dialog).toHaveCount(0);
    const added = (await apiFor(page).tasks.list()).filter((task) => task.title.includes(marker));
    expect(added).toHaveLength(1);
    expect(added[0]!.status).toBe("doing");
    expect(await asks(added[0]!.id)).toBe(1);
  } finally {
    await removeTasks(page, marker);
  }
});

test("refuses to ask the teammate you saw once the task is someone else's", async ({ page }) => {
  const marker = uniqueName("Tess");
  const ada = uniqueName("Ada");
  const bea = uniqueName("Bea");
  await createTeammate(page, ada, "researcher");
  await createTeammate(page, bea, "travel planner");
  try {
    const { id } = await worker.tasks.create({
      title: `Plan the offsite ${marker}`,
      ownerTeammateId: await teammateIdOf(page, ada),
    });
    await page.goto("/tasks");
    await page.getByTestId("task").filter({ hasText: marker }).click();
    const dialog = page.getByTestId("task-dialog");
    await expect(dialog.getByRole("button", { name: `Ask ${ada} to start` })).toBeVisible();
    // Given to Bea elsewhere, while this dialog still says Ada.
    await worker.tasks.update({ taskId: id, ownerTeammateId: await teammateIdOf(page, bea) });
    await dialog.getByRole("button", { name: `Ask ${ada} to start` }).click();
    await expect(
      page.getByText(`That task is ${bea}'s now, so nobody was asked. Check it, then ask again.`),
    ).toBeVisible();
    expect(await asks(id)).toBe(0);
    // Nothing the dialog didn't change was written back: it's still Bea's.
    const task = await apiFor(page).tasks.get({ taskId: id });
    expect(task.ownerTeammateId).toBe(await teammateIdOf(page, bea));
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
