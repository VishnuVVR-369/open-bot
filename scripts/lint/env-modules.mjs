// The one module per app that reads the environment. ESLint refuses `process.env` everywhere else
// in apps and packages (eslint.config.mjs), and scripts/check/env-docs.test.mjs checks that every
// variable these modules read is documented.
//
// `dotenv`: the app reads the repository's root `.env` in development, so `.env.example` lists
// its variables.

/** @type {{ path: string, dotenv: boolean }[]} */
export const ENV_MODULES = [
  { path: "apps/worker/src/env.ts", dotenv: true },
  { path: "apps/web/src/lib/server/env.ts", dotenv: true },
  { path: "apps/pages/src/env.ts", dotenv: true },
  // Build-time values Next.js inlines into the browser too; server settings stay in lib/server/env.ts.
  { path: "apps/web/src/lib/public-env.ts", dotenv: false },
  { path: "apps/botd/src/env.ts", dotenv: false },
  { path: "apps/mobile/src/lib/config.ts", dotenv: false },
  { path: "apps/desktop/src/env.ts", dotenv: false },
  { path: "apps/site/src/lib/site.ts", dotenv: false },
];

/**
 * Files that may also read `process.env`: tests, CLIs and build scripts, and tool config files,
 * which run outside the apps. Each new exception is a decision; add it here with a reason.
 */
export const ENV_EXCEPTIONS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  // Tool configs at a workspace's root (next, Expo, Playwright, drizzle-kit), never under src.
  "apps/*/*.config.{ts,mts,mjs,js}",
  "packages/*/*.config.{ts,mts,mjs,js}",
  "apps/*/scripts/**",
  "apps/*/build.mjs",
  "apps/*/e2e/**",
  "packages/*/scripts/**",
  // The test database helper: TEST_DATABASE_URL and CI, documented with the test variables.
  "packages/db/src/testing.ts",
  // `pnpm db:migrate`, a CLI the worker's pre-deploy step runs.
  "packages/db/src/migrate.ts",
];
