import { createWorkerClient } from "@open-bot/api/worker";
import { expect, type Locator, type Page } from "@playwright/test";

export const owner = {
  email: process.env.E2E_EMAIL ?? process.env.OWNER_EMAIL ?? "",
  password: process.env.E2E_PASSWORD ?? "",
};

/** The worker's internal API, for setup the UI doesn't need to cover. */
export const worker = createWorkerClient({
  url: process.env.WORKER_URL ?? "http://127.0.0.1:4001",
  secret: process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
});

/** Create a teammate through the form and land in their chat. */
export async function createTeammate(
  page: Page,
  name: string,
  role = "test assistant",
  autonomy = "Asks before risky actions",
) {
  await page.goto("/bots/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Job").fill(role);
  await page.getByText(autonomy, { exact: true }).click();
  await page.getByRole("button", { name: "Create teammate" }).click();
  await page.waitForURL(/\/chats\//);
  await expect(page.getByText(`Give ${name} something to do`)).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  const runs = await page.getByTestId("run").count();
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("run")).toHaveCount(runs + 1, { timeout: 30_000 });
}

/** Wait until the newest run reaches one of the given states. */
export async function waitForLastRun(page: Page, states: string[], timeout = 240_000) {
  await expect
    .poll(async () => page.getByTestId("run").last().getAttribute("data-status"), {
      timeout,
      intervals: [1_000],
    })
    .toMatch(new RegExp(`^(${states.join("|")})$`));
}

export function uniqueName(prefix: string) {
  return `${prefix}${Math.random().toString(36).slice(2, 6)}`;
}

/** A teammate's id, by name. */
export async function botIdOf(page: Page, name: string): Promise<string> {
  const state = (await (await page.request.get("/api/state")).json()) as {
    bots: { id: string; name: string }[];
  };
  return state.bots.find((bot) => bot.name === name)!.id;
}

/**
 * Approves a pending approval card. A long email has to be read in full first: its primary
 * action is "Review full email" until then, and Approve shows after it.
 */
export async function approve(card: Locator) {
  const review = card.getByTestId("review");
  if (await review.isVisible()) await review.click();
  await card.getByTestId("approve").click();
}
