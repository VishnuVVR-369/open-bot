import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "./fixtures";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

/** A web page the tests can change, served on this machine for the worker to watch. */
async function servePage(initial: string) {
  let body = initial;
  const server = http.createServer((request, response) => {
    if (request.url !== "/item") {
      response.writeHead(404).end("Not here");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><h1>Blue kettle</h1>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/item`,
    base: `http://127.0.0.1:${port}`,
    set: (next: string) => (body = next),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function newAutomation(page: Page, kind: "Schedule" | "Page watch" | "Webhook") {
  await page.goto("/automations");
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByRole("menuitem", { name: kind }).click();
}

async function pickTeammate(page: Page, name: string) {
  await page.getByRole("dialog").getByRole("combobox").first().click();
  await page.getByRole("option", { name }).click();
}

test("watch a page: the first look, checking now, a failing page, and deleting", async ({
  page,
}) => {
  const shop = await servePage("<p>Sold out</p>");
  try {
    const name = uniqueName("Tess");
    await createTeammate(page, name);
    const title = `E2E kettle ${Math.random().toString(36).slice(2, 6)}`;

    await newAutomation(page, "Page watch");
    await pickTeammate(page, name);
    await page.getByLabel("Name").fill(title);
    await page.getByRole("textbox", { name: "Page", exact: true }).fill("not a url");
    await page.getByLabel("What to do").click();
    await expect(page.getByText("Enter a full web address")).toBeVisible();
    await page.getByRole("textbox", { name: "Page", exact: true }).fill(shop.url);
    await page.getByLabel("Only when this appears").fill("In stock");
    await page.getByLabel("What to do").fill("Tell me it's back in stock.");
    await page.getByRole("button", { name: "Start watching" }).click();

    const row = page.getByTestId("watch").filter({ hasText: title });
    await expect(row).toContainText("waiting for “In stock”");
    // A new watch looks at the page right away, to learn what it looks like.
    await expect(row).toContainText("No changes yet · checked");

    await row.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText("No change", { exact: true })).toBeVisible();

    // Point it at a page that doesn't exist: the failure shows on the row.
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("textbox", { name: "Page", exact: true })).toHaveValue(shop.url);
    await page.getByRole("textbox", { name: "Page", exact: true }).fill(`${shop.base}/gone`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(row.getByTestId("watch-error")).toContainText("The page answered 404");

    await row.getByTestId("automation-toggle").click();
    await expect(row).toContainText("Tell me it's back in stock.");
    await expect(row).toContainText("The page hasn't changed yet.");

    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await shop.close();
  }
});

test("a webhook gets a private URL that can be replaced and paused", async ({ page }) => {
  const name = uniqueName("Tess");
  await createTeammate(page, name);
  const title = `E2E hook ${Math.random().toString(36).slice(2, 6)}`;

  await newAutomation(page, "Webhook");
  await pickTeammate(page, name);
  await page.getByLabel("Name").fill(title);
  await page.getByLabel("What to do").fill("Summarize what came in.");
  await page.getByRole("button", { name: "Create webhook" }).click();
  await expect(page.getByText("Webhook created")).toBeVisible();

  const row = page.getByTestId("webhook").filter({ hasText: title });
  await expect(row).toContainText("Webhook · not called yet");
  await row.getByTestId("automation-toggle").click();
  const address = row.getByTestId("webhook-url");
  await expect(address).toContainText("/api/hooks/");
  const first = (await address.textContent())!;
  await expect(row).toContainText("This address only works on this computer.");

  await row.getByRole("button", { name: "New URL" }).click();
  await expect(address).not.toHaveText(first);
  const second = (await address.textContent())!;
  // The old URL stops working.
  expect((await page.request.post(first, { data: { hello: "world" } })).status()).toBe(404);

  await row.getByRole("switch", { name: "Pause" }).click();
  await expect(row).toContainText("paused");
  const paused = await page.request.post(second, { data: { hello: "world" } });
  expect(paused.status()).toBe(409);
  expect(await paused.json()).toEqual({ error: "This webhook is paused" });

  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.post(second, { data: {} })).status()).toBe(404);
});

test("unknown webhooks and oversized requests are refused", async ({ page }) => {
  expect((await page.request.post("/api/hooks/short")).status()).toBe(404);
  expect((await page.request.post(`/api/hooks/${"x".repeat(32)}`)).status()).toBe(404);
  const big = await page.request.post(`/api/hooks/${"x".repeat(32)}`, {
    data: "x".repeat(300 * 1024),
    headers: { "content-type": "text/plain" },
  });
  expect(big.status()).toBe(413);
});

// These start real bots: slow, and they use your ChatGPT plan.
test.describe("@agent automations at work", () => {
  test.setTimeout(6 * 60_000);

  test("a webhook wakes a bot with what it received", async ({ page }) => {
    const name = uniqueName("Ben");
    await createTeammate(page, name, "order clerk");
    const title = `E2E orders ${Math.random().toString(36).slice(2, 6)}`;
    await newAutomation(page, "Webhook");
    await pickTeammate(page, name);
    await page.getByLabel("Name").fill(title);
    await page
      .getByLabel("What to do")
      .fill("Reply with only the order number from the request, nothing else.");
    await page.getByRole("button", { name: "Create webhook" }).click();
    const row = page.getByTestId("webhook").filter({ hasText: title });
    await row.getByTestId("automation-toggle").click();
    const url = (await row.getByTestId("webhook-url").textContent())!;

    const response = await page.request.post(url, { data: { order: "E2E-4521", total: 12.5 } });
    expect(response.status()).toBe(202);
    await expect(row).toContainText("last called");
    await row.getByTestId("automation-run").first().click();
    await expect(page).toHaveURL(/\/chats\//);
    await waitForLastRun(page, ["completed"]);
    const run = page.getByTestId("run").last();
    await expect(run).toContainText(title);
    await expect(run).toContainText("E2E-4521");
  });

  test("a page watch wakes a bot when the text appears", async ({ page }) => {
    const shop = await servePage("<p>Sold out</p>");
    try {
      const name = uniqueName("Ben");
      await createTeammate(page, name, "shopping assistant");
      const title = `E2E restock ${Math.random().toString(36).slice(2, 6)}`;
      await newAutomation(page, "Page watch");
      await pickTeammate(page, name);
      await page.getByLabel("Name").fill(title);
      await page.getByRole("textbox", { name: "Page", exact: true }).fill(shop.url);
      await page.getByLabel("Only when this appears").fill("In stock");
      await page
        .getByLabel("What to do")
        .fill("Reply with only the line from the page that says it's in stock.");
      await page.getByRole("button", { name: "Start watching" }).click();
      const row = page.getByTestId("watch").filter({ hasText: title });
      await expect(row).toContainText("No changes yet · checked");

      shop.set("<p>In stock: 3 left</p>");
      await row.getByRole("button", { name: "Check now" }).click();
      await expect(page.getByText(`“${title}” changed`)).toBeVisible();
      await row.getByTestId("automation-toggle").click();
      await row.getByTestId("automation-run").first().click();
      await waitForLastRun(page, ["completed"]);
      await expect(page.getByTestId("run").last()).toContainText("3 left");
    } finally {
      await shop.close();
    }
  });

  test("asked in chat, a bot sets up a page watch for itself", async ({ page }) => {
    const shop = await servePage("<p>Sold out</p>");
    try {
      const name = uniqueName("Ben");
      await createTeammate(page, name, "shopping assistant");
      await sendMessage(
        page,
        `Watch ${shop.url} every hour and tell me when it says "In stock". Call the watch "E2E kettle". Don't open the page yourself.`,
      );
      await waitForLastRun(page, ["completed"]);
      await expect(page.getByTestId("run").last()).toContainText("Watching “E2E kettle”");
      await page.goto("/automations");
      const row = page.getByTestId("watch").filter({ hasText: "E2E kettle" });
      await expect(row).toContainText(`set by ${name}`);
      await expect(row).toContainText("every hour");
      await expect(row).toContainText("No changes yet · checked");
    } finally {
      await shop.close();
    }
  });
});
