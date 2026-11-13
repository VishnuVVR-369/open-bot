# e2e

Playwright specs that drive the whole stack through the browser, and stand-ins for outside services.
A spec proves a flow end to end; logic that needs no browser is tested next to its code.
The full guide, with every command and variable, is "End-to-end tests" in `apps/site/src/app/docs/development/page.mdx`.

## Entry points

- `playwright.config.ts` (repo root): one `setup` project that signs in, then the `app` project, run serially.
- `e2e/stack.ts`: which stack a run targets, and the per-run tag helpers (`uniqueName()`, `testLabel()`, `testSlug()`, `testApiKey()`).
- `e2e/global-setup.ts` and `e2e/global-teardown.ts`: give the run its tag, and delete only what carries it.
- `e2e/shared-state.ts`: `suiteLock()` and `savePlanSettings()` for specs that change what the whole app shares.
- `e2e/fixtures.ts`: the `test` and `expect` every spec imports.
- `e2e/helpers.ts`: API clients and shared actions (`createTeammate()`, `sendMessage()`, `waitForLastRun()`).
- `e2e/stand-ins/`: one file per outside service (Telegram, Google and Notion, an MCP server, Job Scout).

## Invariants

- A run names its stack in full: `E2E_STACK=dev` alone, or all of `E2E_BASE_URL`, `DATABASE_URL`, `WORKER_URL` and `BOTD_URL`.
  Anything else stops before the first test.
- Specs write to a real database and computer, so everything a spec creates carries the run's tag, and cleanup deletes only tagged rows.
  Never delete by a fixed name or by time.
- A spec that changes shared settings (plan, email, accounts, Telegram) holds `suiteLock()` and puts back only what it changed.
- Tests run with one worker, because they share one computer and one database.
- Tests tagged `@agent` run real turns on the computer, take minutes and use the owner's ChatGPT plan; leave them out unless asked.
- A stand-in replaces an outside service, never open-bot's own code.
  Use "stand-in" for it, not mock or fake.
- Wait on what the page shows, never on a sleep.

## Run

- Fast suite on the local stack: `E2E_STACK=dev E2E_EMAIL=... E2E_PASSWORD=... pnpm e2e --grep-invert @agent`.
- One spec: add its path, for example `pnpm e2e e2e/tasks.spec.ts`.
- The local stack is the owner's own data.
  Prefer the self-contained runners (`pnpm test:pocket-inbox`, `pnpm test:memory -- --e2e`, `pnpm test:computer-sleep`) or a throwaway stack.
- Types: `pnpm typecheck` checks the specs (`e2e/tsconfig.json`).
