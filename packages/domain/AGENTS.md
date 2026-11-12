# packages/domain

Isomorphic types, zod schemas and pure logic used by web, worker, mobile and the other packages.
It must stay runnable in a browser and in React Native.
Database access goes in `packages/db`, OAuth and token storage in `packages/integrations`, runtime behavior in the apps.

## Layout

One folder per feature under `packages/domain/src`, each with an `index.ts` barrel:

- `teammates`: profile options, creation and edit schemas (`management.ts`), export bundles, templates, status.
- `computer`: botd's wire protocol (`protocol.ts`), screen operations, disk paths, file kinds.
- `egress`: the owner's settings for which devices carry the browser's traffic.
- `events`: the app events announced to open tabs and phones (`appEventSchema`).
- `timeline`: run timeline items and their reducer.
- `approvals`: always-allow rules, how approvals are shown, and the job-application guard.
- `automations`: schedules and triggers.
- `integrations`: MCP connections and the OAuth account definitions (`integrations/accounts`).
- `pages`, `skills`, `memory`, `vault`, `models`, `channels` (Telegram, email), `auth` (password, recovery) and `text`.
- `server`: Node-only helpers, see below.

## Entry points

- `@open-bot/domain` is `packages/domain/src/index.ts`, which re-exports every feature folder except `server`.
- `@open-bot/domain/server` is `packages/domain/src/server/index.ts`: signed tokens for VNC and the egress tunnel (`tokens.ts`), AES-256-GCM for secrets at rest (`secrets.ts`), and signed links to one page version (`page-links.ts`).

## Invariants

- Code in `packages/domain/src/server` imports `node:crypto`, so it is a separate entry and is never re-exported from `index.ts`.
- Lint enforces both directions: the isomorphic folders cannot import `node:*` or `server`, and `apps/mobile`, `packages/api` and web client code cannot import `@open-bot/domain/server`.
- Keep zod schemas for stored or exported data optional or defaulted, so old exports and old rows still parse (`packages/domain/src/teammates/bundle.ts`).
- New workspace dependencies must also be added to the consumer bundlers (see the repo map in the root `AGENTS.md`).

## Why account definitions live here

- `packages/domain/src/integrations/accounts`: definitions that both web and mobile can read (providers, scopes, tools, settings). It has no Node or database code.
- `packages/db` types its columns with unions derived from them, so they sit below `packages/db`.
- `packages/integrations` has the rest of each provider: sign-in, the token store, and the adapters that call Gmail, Calendar and Notion. It needs Node and the database.
- The worker refuses to start if adapters and definitions disagree (`specProblem` in `packages/integrations/src/integration-registry.ts`).
- The step-by-step recipe is "Add an account provider" in the root `AGENTS.md`.

## Tests

- `pnpm --filter @open-bot/domain test` runs the Vitest suites next to the code.
- `pnpm --filter @open-bot/domain typecheck` checks types.

## Docs

- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/flows/accounts/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
