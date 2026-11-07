// Signs in as the showcase owner through the real login form and saves a Playwright storage state.
//
//   node tools/showcase/auth.mjs [output.json]
//
// The state also carries the "last active" marks the app keeps in localStorage, set to ten hours
// ago, so Home shows its "While you were away" briefing in screenshots.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.SHOWCASE_URL ?? "http://localhost:3200";
const OUTPUT = process.argv[2] ?? "/tmp/ui/showcase-auth.json";
const EMAIL = "alex@showcase.local";
const PASSWORD = "showcase-demo-2026";

const require = createRequire(path.join(root, "package.json"));
const mod = await import(pathToFileURL(require.resolve("@playwright/test")).href);
const chromium = mod.chromium ?? mod.default.chromium;

mkdirSync(path.dirname(OUTPUT), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
try {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 120_000 });
  await page.evaluate(() => {
    const since = String(Date.now() - 10 * 60 * 60_000);
    localStorage.setItem("open-bot:last-active", since);
    localStorage.setItem("open-bot:briefing-since", since);
  });
  await context.storageState({ path: OUTPUT });
  console.log(`Saved ${OUTPUT}`);
} finally {
  await browser.close();
}
