import pg from "pg";
import { expect, test, type Page } from "./fixtures";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";
import { ordersService } from "./mcp-stand-in";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
});

// A test's connections would reach every teammate in the tests after it.
test.afterEach(() => pool.query("delete from connections where label like 'E2E %'"));
test.afterAll(() => pool.end());

async function connect(page: Page, input: { label: string; url: string; headers?: string }) {
  await page.goto("/settings#connections");
  const section = page.getByTestId("connections");
  await section.getByRole("button", { name: "Connect a service" }).click();
  const dialog = page.getByTestId("connection-dialog");
  await dialog.getByLabel("Name").fill(input.label);
  await dialog.getByLabel("MCP address").fill(input.url);
  if (input.headers) await dialog.getByLabel("Headers").fill(input.headers);
  await dialog.getByTestId("connection-save").click();
  await expect(dialog).toHaveCount(0);
  return section.getByTestId("connection").filter({ hasText: input.label });
}

test("connect a service through MCP and see its tools", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const service = await ordersService();
  const label = `E2E Orders ${Math.random().toString(36).slice(2, 6)}`;
  try {
    const row = await connect(page, {
      label,
      url: service.url,
      headers: "Authorization: Bearer orders-token-123",
    });
    // Saving tests it from the computer, with its token.
    await expect(row.getByTestId("connection-test")).toContainText("Connected · 1 tool", {
      timeout: 60_000,
    });
    await expect(row.getByTestId("connection-test")).toContainText("lookup_order");
    expect(service.seen.authorization).toContain("Bearer orders-token-123");

    // The token never comes back to the browser, and an edit keeps it.
    const listed = await (await page.request.get("/api/connections")).text();
    expect(listed).not.toContain("orders-token-123");
    expect(listed).toContain("Authorization");
    service.seen.authorization.length = 0;
    await row.getByRole("button", { name: `Edit ${label}` }).click();
    const dialog = page.getByTestId("connection-dialog");
    await expect(dialog.getByLabel("Headers")).toHaveAttribute(
      "placeholder",
      /Saved: Authorization/,
    );
    await dialog.getByTestId("connection-save").click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByTestId("connection-test")).toContainText("Connected", {
      timeout: 60_000,
    });
    expect(service.seen.authorization).toContain("Bearer orders-token-123");

    // Off, then removed.
    await row.getByRole("switch", { name: `Use ${label}` }).click();
    await expect(row).toContainText("Off");
    await row.getByRole("button", { name: `Remove ${label}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await service.stop();
  }
});

test("a service that can't be reached says so", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const label = `E2E Nowhere ${Math.random().toString(36).slice(2, 6)}`;
  const row = await connect(page, { label, url: "http://host.docker.internal:9/mcp" });
  await expect(row.getByTestId("connection-test")).toContainText("Couldn't reach", {
    timeout: 90_000,
  });
});

test("@agent a teammate uses a connected service's tools", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const service = await ordersService();
  const label = `E2E Orders ${Math.random().toString(36).slice(2, 6)}`;
  try {
    const row = await connect(page, { label, url: service.url });
    await expect(row.getByTestId("connection-test")).toContainText("Connected", {
      timeout: 60_000,
    });
    await createTeammate(page, uniqueName("Ivy"), "support assistant");
    await sendMessage(
      page,
      `Where is order 4821, and when does it arrive? Look it up with the ${label} service.`,
    );
    await waitForLastRun(page, ["completed"]);
    const run = page.getByTestId("run").last();
    await expect(run).toContainText(/Friday/i);
    expect(service.seen.calls).toContain("4821");
  } finally {
    await service.stop();
  }
});
