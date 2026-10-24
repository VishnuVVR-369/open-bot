import { expect, test } from "./fixtures";
import {
  botIdOf,
  createTeammate,
  sendMessage,
  uniqueName,
  waitForLastRun,
  workerApi,
} from "./helpers";

const LESSON = "Always end every reply with the word PINEAPPLE on its own line.";

test("a teammate's Memory tab explains lessons before there are any", async ({ page }) => {
  const name = uniqueName("Tess");
  await createTeammate(page, name);
  const botId = await botIdOf(page, name);
  await page.goto(`/bots/${botId}?tab=memory`);
  await expect(page.getByRole("tab", { name: "Memory" })).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("lessons")).toContainText(
    `${name} keeps it as a lesson and reads it before every task.`,
  );
  await expect(page.getByLabel(`${name}'s memory`)).toBeVisible();
});

test("@agent rate a reply, teach a lesson, and see it used in a new chat", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const name = uniqueName("Tess");
  await createTeammate(page, name);
  const chatUrl = page.url();
  await sendMessage(page, "What is the capital of France? Answer in one short sentence.");
  await waitForLastRun(page, ["completed"]);

  const run = page.getByTestId("run").last();
  await run.hover();
  await run.getByRole("button", { name: "Good reply" }).click();
  await expect(run.getByRole("button", { name: "Good reply" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(
    page.getByTestId("run").last().getByRole("button", { name: "Good reply" }),
  ).toHaveAttribute("aria-pressed", "true");

  // A thumbs down asks what to change, and the teammate tries again.
  await page.getByTestId("run").last().hover();
  await page.getByTestId("run").last().getByRole("button", { name: "Bad reply" }).click();
  const form = page.getByTestId("feedback-form");
  await expect(form).toContainText(`What should ${name} do differently?`);
  await form.getByRole("textbox").fill(LESSON);
  await form.getByRole("button", { name: "Try again with this" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText(`${name} will remember that`)).toBeVisible();
  await expect(page.getByText(LESSON)).toBeVisible();
  await expect(page.getByText("Asked to try again")).toBeVisible();
  await expect(page.getByTestId("run")).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByTestId("run").first().getByRole("button", { name: "Bad reply" }),
  ).toHaveAttribute("aria-pressed", "true");
  await waitForLastRun(page, ["completed"]);
  await expect(page.getByTestId("run").last()).toContainText("PINEAPPLE");

  // The lesson is on the teammate's page, and a brand new chat follows it.
  await page.getByRole("button", { name: "See lessons" }).click();
  await page.waitForURL(/\?tab=memory/);
  const lesson = page.getByTestId("lesson");
  await expect(lesson).toHaveCount(1);
  await expect(lesson).toContainText(LESSON);
  await expect(lesson.getByRole("link", { name: "See the reply" })).toHaveAttribute(
    "href",
    /\/chats\/.+#run-/,
  );

  const botId = await botIdOf(page, name);
  const state = (await (await page.request.get("/api/state")).json()) as {
    bots: { id: string; slug: string }[];
  };
  const slug = state.bots.find((bot) => bot.id === botId)!.slug;
  await page.goto(chatUrl);
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByText(`Give ${name} something to do`)).toBeVisible();
  await sendMessage(page, "What is 2 + 2? Answer in one short sentence.");
  await waitForLastRun(page, ["completed"]);
  const agents = await workerApi<{ dataBase64: string }>(
    `/internal/files/read?path=/home/bot/bots/${slug}/AGENTS.md`,
  );
  expect(Buffer.from(agents.dataBase64, "base64").toString()).toContain(`- ${LESSON}`);
  await expect(page.getByTestId("run").last()).toContainText("PINEAPPLE");

  // Forgetting it takes it off the list.
  await page.goto(`/bots/${botId}?tab=memory`);
  await page.getByRole("button", { name: "Forget this lesson" }).click();
  await expect(page.getByTestId("lesson")).toHaveCount(0);
  await expect(page.getByTestId("lessons")).toContainText("Nothing yet.");
});
