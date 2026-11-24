---
name: openbot-feature
description: Use when adding an open-bot feature that crosses layers (types, a table, a worker service with tools and routes, API procedures, web or mobile screens). Walks the current layout end to end and points at the recipe for each step.
---

# Add an open-bot feature

The workspace `AGENTS.md` files hold the recipes: which files one step touches, in order.
This skill puts those steps in order for a whole feature and names the code to copy.
It does not repeat the recipes; open each one when you reach its step.

## The example to copy

`tasks` (the team's task board) is the smallest feature that has every server layer.
Read its files in this order before you write yours:

| Layer             | Tasks                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types and schemas | `packages/domain/src/tasks/tasks.ts`, exported through `packages/domain/src/tasks/index.ts`                                                        |
| Table             | `packages/db/src/schema/tasks.ts`; its writer in `packages/db/src/owners.ts`                                                                       |
| Worker feature    | `apps/worker/src/features/tasks/` (`service.ts`, `tools.ts`, `routes.ts`, `index.ts`)                                                              |
| Worker wiring     | `apps/worker/src/index.ts` (builds the service), `apps/worker/src/tools/definitions.ts`, `apps/worker/src/rpc/router.ts`                           |
| Contracts         | `packages/api/src/contracts/tasks.ts` (app), `packages/api/src/worker/contracts/tasks.ts` (internal), `packages/api/src/tasks.ts` (views)          |
| Web feature       | `apps/web/src/features/tasks/` (`components/`, `hooks.ts`, `index.ts`, `server.ts`, `server/queries.ts`, `server/routes.ts`)                       |
| Web wiring        | `apps/web/src/app/(app)/tasks/page.tsx`, `apps/web/src/lib/server/api/router.ts`                                                                   |
| Mobile            | `apps/mobile/src/features/tasks/` (`components/`, `hooks.ts`, `actions.ts`), routes in `apps/mobile/src/app/tasks/`                                |
| Realtime event    | `tasks` in `APP_EVENT_TYPES` and `APP_EVENT_REFRESHES`                                                                                             |
| Tests             | `apps/worker/src/features/tasks/routes.integration.test.ts`, `apps/web/src/features/tasks/server/queries.integration.test.ts`, `e2e/tasks.spec.ts` |
| Docs              | `apps/site/src/app/docs/reference/tools/page.mdx`, `apps/site/src/app/docs/flows/teamwork/page.mdx`                                                |

Layout rules both apps share (the board's columns and order) live in `packages/domain/src/tasks/board.ts`, so web and mobile can't drift apart.
For background work or a signal from the web app, copy a small `feature.ts`, such as `apps/worker/src/features/notifications/feature.ts`.

## Steps

1. **Name it and decide who writes.**
   Use the glossary in the root `AGENTS.md`; the feature folder has the same name in the worker, web and mobile.
   Every table has one writer, normally the worker feature's `service.ts`.
   Web server code may read any table, and changes one it doesn't own through the worker's internal API.
2. **Types and zod schemas** in `packages/domain/src/<feature>/`, exported from its `index.ts` and `packages/domain/src/index.ts`.
   It runs in browsers and on phones: no Node, no database (`packages/domain/AGENTS.md`, lint enforces it).
   A field added to a teammate has its own recipe there ("Add a field to a teammate").
3. **The table:** "Add a database table or column" in `packages/db/AGENTS.md`, including its owner in `packages/db/src/owners.ts`.
4. **The worker feature folder** `apps/worker/src/features/<feature>/` (layout under "Entry points" in `apps/worker/AGENTS.md`):
   - `service.ts`: the rules and every write; it publishes app events with `publishApp`, and refuses with its own error class that extends `WorkerError`.
   - `tools.ts`: "Add an agent tool (non-account)" in `apps/worker/AGENTS.md`.
   - `routes.ts`: "Add a worker internal route (called by web)" in `apps/worker/AGENTS.md`.
   - `feature.ts`, only for background work or web app signals.
   - `index.ts`: the only file code outside the folder imports; `core/` never imports a feature.
5. **Contracts** in `packages/api`: the app's procedures and views (step 2 of "Add a web screen" in `apps/web/AGENTS.md`), and the internal procedures (step 1 of the worker route recipe).
   Shapes only, serializable, no Node (`packages/api/AGENTS.md`).
6. **Web:** "Add a web screen" in `apps/web/AGENTS.md`.
   Views and hooks are client code; anything that touches the database stays under `server/`, reached through `server.ts`.
7. **Mobile:** "Add a mobile screen" in `apps/mobile/AGENTS.md`.
   It reuses the app contract from step 5; there is no mobile-only API.
8. **Realtime refresh:** "Add a realtime event" in `packages/domain/AGENTS.md`, unless an existing event already covers the change.
9. **Tests at each level.** Each should fail without your change:
   - Domain logic: a unit test beside the file (`pnpm --filter @open-bot/domain test`).
   - Worker service, tools and routes: integration suites in the feature folder, set up with `apps/worker/src/testing/tools.ts` and `apps/worker/src/testing/rpc.ts`; the tool list snapshot (`pnpm --filter @open-bot/worker test -u`, then review it).
   - Web reads and procedures: `server/*.integration.test.ts` in the feature, with `apps/web/src/test/api/harness.ts`.
   - Mobile: unit tests beside the hook or helper (`pnpm --filter @open-bot/mobile test`).
   - The whole flow: a spec in `e2e/` (`e2e/AGENTS.md`), using stand-ins for outside services.
10. **Docs.**
    New tools in `apps/site/src/app/docs/reference/tools/page.mdx`, new internal routes in `apps/site/src/app/docs/reference/http-api/page.mdx`, and the behavior in its flow or architecture page ("Architecture docs" in the root `AGENTS.md`).
    A changed recipe is updated in the `AGENTS.md` that owns it.
11. **Verify and ship.**
    `pnpm check:fast` runs most of the guardrails a new feature trips: file size, import cycles, client imports, table owners and vocabulary.
    The feature boundary tests run with each app's unit tests, so `pnpm verify:affected` catches those.
    "Code structure" in `apps/site/src/app/docs/development/page.mdx` says what fails each guardrail and how to fix it.
    Then use the openbot-ui-review skill for the screens, and the openbot-ship skill before the PR.
