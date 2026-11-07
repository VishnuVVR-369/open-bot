import { defineConfig, devices } from "@playwright/test";

// Run with pnpm test:pocket-inbox; evidence output is opt-in via POCKET_TEST_EVIDENCE_DIR.
const databaseUrl = process.env.POCKET_TEST_DATABASE_URL;
if (
  !databaseUrl ||
  !["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname) ||
  new URL(databaseUrl).pathname !== "/openbot_pocket_test"
) {
  throw new Error(
    "Use a disposable local openbot_pocket_test database via POCKET_TEST_DATABASE_URL.",
  );
}
const port = Number(process.env.POCKET_TEST_PORT ?? 3141);
const url = `http://localhost:${port}`;
export default defineConfig({
  testDir: "e2e",
  testMatch: "pocket-inbox.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: url, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm --filter @open-bot/web exec next dev --port ${port}`,
    url,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: databaseUrl,
      OWNER_EMAIL: "pocket-e2e@example.test",
      BETTER_AUTH_URL: url,
      BETTER_AUTH_SECRET: "pocket-e2e-only-secret-for-isolated-tests",
      WORKER_URL: "http://127.0.0.1:49998",
      OPENBOT_NEXT_DIST_DIR: ".next/pocket-e2e",
    },
  },
});
