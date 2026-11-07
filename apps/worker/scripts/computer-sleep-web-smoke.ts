import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { createApiClient } from "@open-bot/api";

const appUrl = process.env.SLEEP_TEST_APP_URL ?? "http://127.0.0.1:13001";
const workerUrl = process.env.SLEEP_TEST_WORKER_URL ?? "http://127.0.0.1:14097";
assert(
  new URL(appUrl).hostname === "127.0.0.1" && new URL(workerUrl).hostname === "127.0.0.1",
  "Only isolated localhost fixtures are allowed",
);
const response = await fetch(workerUrl + "/internal/bots", {
  method: "POST",
  headers: {
    "x-worker-secret": "sleep-test-worker-secret-20261107",
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: "Web sleep fixture", role: "Lifecycle web verification" }),
});
assert(response.ok);
const { botId } = (await response.json()) as { botId: string };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
const phases: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", async (r) => {
  if (new URL(r.url()).pathname !== "/api/state" || !r.ok()) return;
  const state = await r.json().catch(() => null);
  if (state?.computer?.lifecycle?.phase) phases.push(state.computer.lifecycle.phase);
});
try {
  await page.goto(appUrl);
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Your name").fill("Sleep test owner");
  await page.getByLabel("Email").fill("sleep-ui@openbot.test");
  await page.getByLabel("Password").fill(randomBytes(24).toString("base64url"));
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(appUrl + "/");
  await page.goto(appUrl + "/computer?screen=" + botId);
  await expect(page.getByText("Computer idle", { exact: true })).toBeVisible({ timeout: 15000 });
  const idleState = await (await page.request.get(appUrl + "/api/state")).json();
  assert.equal(idleState.computer.lifecycle.phase, "idle");
  await page.getByTestId("wake-screen").click();
  await expect(page.getByTestId("computer-screen").locator("canvas")).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({ path: "/tmp/openbot-sleep-web-ready.png" });
  await expect(page.getByText("Computer idle", { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("computer-screen").locator("canvas")).toHaveCount(0);
  const cookies = (await context.cookies())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const api = createApiClient({ appUrl, headers: () => ({ cookie: cookies }) });
  const screens = await api.screens.list();
  const screen = screens.find((s) => s.id === botId);
  assert.equal(screen?.lifecycle?.phase, "idle");
  assert.equal(screen?.running, false);
  assert.equal(screen?.online, true, "mobile contract offers an explicit wake while idle");
  const after = await (await page.request.get(appUrl + "/api/state")).json();
  assert.equal(after.codex.stale, true);
  assert(after.codex.account, "authentication remains cached in the web response");
  assert.equal(errors.length, 0, errors.join("\n"));
  const result = {
    at: new Date().toISOString(),
    phases: [...new Set(phases)],
    browserCanvasMounted: true,
    browserCanvasUnmountedOnSleep: true,
    cachedAccount: true,
    mobileApiIdleWakeAvailable: true,
    pageErrors: errors,
  };
  await writeFile("/tmp/openbot-sleep-web-result.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
