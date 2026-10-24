import { expect, type Page } from "@playwright/test";

export const owner = {
  email: process.env.E2E_EMAIL ?? process.env.OWNER_EMAIL ?? "",
  password: process.env.E2E_PASSWORD ?? "",
};

/** Calls the worker's internal API, for setup the UI doesn't need to cover. */
export async function workerApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${process.env.WORKER_URL ?? "http://127.0.0.1:4001"}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-worker-secret": process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** Create a teammate through the form and land in their chat. */
export async function createTeammate(
  page: Page,
  name: string,
  role = "test assistant",
  autonomy = "Ask before risky actions",
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
