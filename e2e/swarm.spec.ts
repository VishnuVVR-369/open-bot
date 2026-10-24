import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

test("@agent a teammate splits a job across helpers and merges their results", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  // Three shops, each with its own price, and a note of which ones were visited.
  const shops: Record<string, { name: string; price: string }> = {
    "/alpha": { name: "Alpha Teas", price: "$14.00" },
    "/bravo": { name: "Bravo Leaf", price: "$7.50" },
    "/charlie": { name: "Charlie & Co", price: "$11.25" },
  };
  const visited = new Set<string>();
  const server = http.createServer((request, response) => {
    const shop = shops[request.url ?? ""];
    if (shop) visited.add(request.url!);
    response.setHeader("content-type", "text/html");
    response.end(
      shop
        ? `<!doctype html><title>${shop.name}</title><body style="font:28px system-ui;margin:60px"><h1>${shop.name}</h1><p>Oolong tea, 250 g</p><p>Price: <b>${shop.price}</b></p></body>`
        : "Not found",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const site = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;

  const vncErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Failed when connecting/.test(message.text()))
      vncErrors.push(message.text());
  });

  try {
    await createTeammate(page, uniqueName("Ora"), "shopper");
    await sendMessage(
      page,
      `Find the cheapest oolong tea. Use start_swarm with 3 helpers, one per shop, each opening its page in the browser, waiting 15 seconds on it with desktop_wait, and reporting the shop's name and price: ${site}/alpha, ${site}/bravo and ${site}/charlie. Then tell me which shop is cheapest.`,
    );

    // A card shows the helpers working, each on a screen of its own.
    const swarm = page.getByTestId("swarm");
    await expect(swarm).toBeVisible({ timeout: 4 * 60_000 });
    await expect(swarm.getByTestId("swarm-task")).toHaveCount(3);
    // Their screens show live while they work.
    await expect(
      swarm.locator('[data-testid="swarm-task"][data-state="running"] canvas').first(),
    ).toBeVisible({ timeout: 3 * 60_000 });
    await expect(swarm).toHaveAttribute("data-state", "done", { timeout: 8 * 60_000 });
    await expect(swarm.locator('[data-testid="swarm-task"][data-state="completed"]')).toHaveCount(
      3,
    );
    expect([...visited].sort()).toEqual(["/alpha", "/bravo", "/charlie"]);
    expect(vncErrors).toEqual([]);

    // Their results come back as one message, which the teammate merges.
    await expect(page.getByTestId("run")).toHaveCount(2, { timeout: 60_000 });
    await waitForLastRun(page, ["completed"]);
    const merged = page.getByTestId("run").last();
    await expect(merged.getByTestId("run-trigger")).toHaveText("With the helpers' results");
    await expect(merged).toContainText("Bravo");

    // Each helper's work opens on its own, and its chat isn't in your lists.
    await swarm.getByTestId("swarm-task").first().click();
    await page.waitForURL(/\/chats\//);
    await expect(page.getByText("A helper works on its part alone.")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
    await expect(page.getByLabel("Helper's screen")).toContainText(
      "Its screen closed when it finished",
    );
  } finally {
    server.close();
  }
});
