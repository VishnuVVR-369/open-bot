import { defineConfig, devices } from "@playwright/test";
import { e2eStack } from "./e2e/stack";

/**
 * End-to-end tests against a running stack, named in full (see `e2e/stack.ts`); `E2E_STACK=dev`
 * means the local development stack (`pnpm infra:up` and `pnpm dev`).
 * Tests tagged @agent drive real teammates on the computer, so they take minutes and use your ChatGPT plan.
 * Run the fast ones with: pnpm e2e --grep-invert @agent
 */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: e2eStack().baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "app",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: "e2e/.auth/owner.json",
      },
    },
  ],
});
