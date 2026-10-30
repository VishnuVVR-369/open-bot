import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the production build, served the way it is deployed:
 * the static site on one origin and the media bucket on another, with the site's _headers applied.
 * Encode the media first: pnpm --filter @open-bot/site media:encode
 * Locally, servers already running on these ports are reused, for example Cloudflare's own runtime:
 * build with the URLs below, then `npx wrangler dev --port 3300` and `node scripts/serve.mjs .media 3301`.
 */
const site = "http://localhost:3300";
const media = "http://localhost:3301";

if (!existsSync(join(__dirname, ".media/tour/v1/master.m3u8"))) {
  throw new Error("The encoded tour is missing. Run: pnpm --filter @open-bot/site media:encode");
}

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: site,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // Google Chrome, not Playwright's Chromium: the tour is H.264 and AAC.
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // WebKit, the engine behind Safari, which handles media its own way.
      name: "safari",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      command: "node scripts/serve.mjs .media 3301",
      url: `${media}/tour/v1/master.m3u8`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm build && node scripts/serve.mjs out 3300",
      url: site,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { NEXT_PUBLIC_SITE_URL: site, NEXT_PUBLIC_MEDIA_URL: media },
    },
  ],
});
