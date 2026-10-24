import { expect, test } from "./fixtures";
import { botIdOf, createTeammate, uniqueName, workerApi } from "./helpers";

test("create, edit and archive a teammate", async ({ page }) => {
  const name = uniqueName("Tess");
  await createTeammate(page, name, "qa assistant");
  await expect(page.getByRole("navigation", { name: "Main" }).getByText(name)).toBeVisible();

  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: `${name}'s settings` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await page.getByLabel("Job").fill("release manager");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(page.getByRole("textbox", { name: `${name}'s memory` })).toContainText("# Memory");

  await page.getByRole("tab", { name: "Profile" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: `Archive ${name}` }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("navigation", { name: "Main" }).getByText(name)).toHaveCount(0);
});

test("create a group chat", async ({ page }) => {
  const a = uniqueName("Ava");
  const b = uniqueName("Ben");
  await createTeammate(page, a);
  await createTeammate(page, b);
  await page.getByRole("button", { name: "New group chat" }).click();
  await page.getByLabel("Name").fill("E2E group");
  await page.getByRole("checkbox", { name: new RegExp(a) }).click();
  await page.getByRole("checkbox", { name: new RegExp(b) }).click();
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Start the conversation")).toBeVisible();
  await page.getByTestId("composer-input").fill(`@${b.slice(0, 2)}`);
  await expect(page.getByRole("option", { name: new RegExp(b) })).toBeVisible();
});

test("duplicate a teammate with their skills and memory", async ({ page }) => {
  const name = uniqueName("Tess");
  await createTeammate(page, name, "qa assistant");
  const id = await botIdOf(page, name);
  const skill = `e2e-${Math.random().toString(36).slice(2, 7)}`;
  await workerApi("/internal/skills", {
    name: skill,
    description: "Only for the original",
    instructions: "Reply with ok.",
    botId: id,
  });
  await page.goto(`/bots/${id}`);
  await page.getByRole("tab", { name: "Memory" }).click();
  const memory = page.getByRole("textbox", { name: `${name}'s memory` });
  await expect(memory).toContainText("# Memory");
  await memory.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n- Likes short answers.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.getByText("Memory saved")).toBeVisible();

  await page.getByTestId("duplicate-bot").click();
  await expect(page.getByTestId("duplicate-name")).toHaveValue(`${name} 2`);
  await page.getByTestId("duplicate-confirm").click();
  await page.waitForURL(/\/chats\//);
  await expect(page.getByText(`Give ${name} 2 something to do`)).toBeVisible();

  const copyId = await botIdOf(page, `${name} 2`);
  await page.goto(`/bots/${copyId}`);
  await expect(page.getByLabel("Job")).toHaveValue("qa assistant");
  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(page.getByRole("textbox", { name: `${name} 2's memory` })).toContainText(
    "Likes short answers.",
  );
  await page.getByRole("tab", { name: "Skills" }).click();
  await expect(page.getByTestId("skill").filter({ hasText: `/${skill}` })).toContainText(
    `Only ${name} 2`,
  );
});

test("start from a template with starter automations", async ({ page }) => {
  await page.goto("/bots/new");
  await page.getByRole("button", { name: "Chief of staff" }).click();
  await expect(page.getByLabel("Job")).toHaveValue("chief of staff");
  const starters = page.getByTestId("starter-automations");
  await expect(starters).toContainText("Plan my week · Every Monday at 8:00 AM");
  await expect(starters).toContainText("Evening wrap-up · Weekdays at 6:00 PM");
  await starters.getByRole("switch", { name: "Evening wrap-up" }).click();

  const name = uniqueName("Ava");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create teammate" }).click();
  await page.waitForURL(/\/chats\//);
  await expect(page.getByText(`${name} starts with 3 automations`)).toBeVisible();

  await page.goto(`/bots/${await botIdOf(page, name)}?tab=automations`);
  const schedules = page.getByTestId("schedule");
  await expect(schedules).toHaveCount(3);
  await expect(schedules.filter({ hasText: "Plan my week" })).toHaveCount(1);
  await expect(schedules.filter({ hasText: "Weekly retro" })).toHaveCount(1);
  // The check-in only speaks up when there's news.
  await expect(schedules.filter({ hasText: "Daily check-in" })).toContainText("only news");
  await expect(
    page.getByTestId("check-in").getByRole("switch", { name: "Daily check-in" }),
  ).toHaveAttribute("aria-checked", "true");

  // Every template checks in and looks back at its week; a developer has nothing else scheduled.
  await page.goto("/bots/new");
  await page.getByRole("button", { name: "Developer" }).click();
  await expect(page.getByTestId("starter-automations").getByRole("switch")).toHaveCount(2);
  await expect(page.getByTestId("starter-automations")).toContainText(
    "Daily check-in · Every day at 9:00 AM",
  );
  await expect(page.getByTestId("starter-automations")).toContainText(
    "Weekly retro · Every Friday at 4:00 PM",
  );
});

test("export a teammate to a file and import it as a new one", async ({ page }) => {
  // A teammate with routines, from a template.
  await page.goto("/bots/new");
  await page.getByRole("button", { name: "Chief of staff" }).click();
  const original = uniqueName("Ava");
  await page.getByLabel("Name").fill(original);
  await page.getByRole("button", { name: "Create teammate" }).click();
  await page.waitForURL(/\/chats\//);
  const botId = await botIdOf(page, original);

  await page.goto(`/bots/${botId}`);
  await expect(page.getByTestId("export-bot")).toHaveAttribute("href", `/api/bots/${botId}/export`);
  const response = await page.request.get(`/api/bots/${botId}/export`);
  expect(response.headers()["content-disposition"]).toMatch(/\.openbot\.json"$/);
  const bundle = (await response.json()) as {
    format: string;
    teammate: { name: string; role: string };
    routines: { title: string }[];
  };
  expect(bundle.format).toBe("open-bot.teammate");
  expect(bundle.teammate.role).toBe("chief of staff");
  expect(bundle.routines.map((routine) => routine.title)).toEqual([
    "Plan my week",
    "Evening wrap-up",
    "Daily check-in",
    "Weekly retro",
  ]);

  const copy = uniqueName("Ben");
  bundle.teammate.name = copy;
  await page.goto("/bots/new");
  await page.getByTestId("import-teammate").setInputFiles({
    name: "teammate.openbot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await page.waitForURL(/\/chats\//);
  await expect(page.getByText(`${copy} joined the team`)).toBeVisible();
  await expect(page.getByText("Their 4 automations are paused.", { exact: false })).toBeVisible();

  await page.goto(`/bots/${await botIdOf(page, copy)}?tab=automations`);
  const schedules = page.getByTestId("schedule");
  await expect(schedules).toHaveCount(4);
  await expect(schedules.first()).toContainText("paused");
  await expect(schedules.filter({ hasText: "Daily check-in" })).toContainText("only news");

  // A file that isn't a teammate says so.
  await page.goto("/bots/new");
  await page.getByTestId("import-teammate").setInputFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"hello": "world"}'),
  });
  await expect(page.getByText("This isn't an open-bot teammate file.")).toBeVisible();
});
