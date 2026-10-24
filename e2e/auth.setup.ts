import { expect, test as setup } from "@playwright/test";
import { owner } from "./helpers";

setup("sign in as the owner", async ({ page }) => {
  setup.setTimeout(180_000);
  setup.skip(
    !owner.email || !owner.password,
    "Set E2E_EMAIL and E2E_PASSWORD (or OWNER_EMAIL) to run the end-to-end tests.",
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/(login|setup)/);
  if (page.url().includes("/setup")) {
    await page.getByLabel("Your name").fill("Owner");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.waitForURL("/");
  await page.context().storageState({ path: "e2e/.auth/owner.json" });
  // A dev server compiles each route on its first visit; do that here, so no test races a compile.
  for (const route of [
    "/bots/new",
    "/computer",
    "/approvals",
    "/automations",
    "/files",
    "/settings",
  ]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  const state = (await (await page.request.get("/api/state")).json()) as {
    bots: { id: string }[];
    chats: { id: string }[];
  };
  if (state.bots[0]) await page.goto(`/bots/${state.bots[0].id}`);
  if (state.chats[0]) await page.goto(`/chats/${state.chats[0].id}`);
});
