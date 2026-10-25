import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MEMORY_E2E_PORT ?? 3137);
const url = `http://localhost:${port}`;
export default defineConfig({
  testDir: "e2e",
  testMatch: "memory.spec.ts",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  expect: { timeout: 15000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: url,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm --filter @open-bot/web exec next dev --port ${port}`,
    url,
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      DATABASE_URL: process.env.MEMORY_TEST_DATABASE_URL ?? "",
      OWNER_EMAIL: "memory-e2e@example.test",
      BETTER_AUTH_URL: url,
      BETTER_AUTH_SECRET: "memory-e2e-only-secret-for-isolated-tests",
      WORKER_URL: "http://127.0.0.1:49998",
    },
  },
});
