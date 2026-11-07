# packages/shared

Isomorphic types, zod schemas and pure logic used by web, worker, mobile and the other packages.
It must stay runnable in a browser and in React Native.
Database access goes in `packages/db`, OAuth and token storage in `packages/accounts`, runtime behavior in the apps.

## Entry points

- `packages/shared/src/index.ts` re-exports the isomorphic modules (timeline, bots, schedule, triggers, bundle, vault, pages, accounts, ...).
- `@open-bot/shared/tokens` is `packages/shared/src/tokens.ts`: signed short-lived tokens for VNC and the egress tunnel.
- `@open-bot/shared/secrets` is `packages/shared/src/secrets.ts`: AES-256-GCM for secrets at rest.
- `@open-bot/shared/page-links` is `packages/shared/src/page-links.ts`: signed links to one page version.
- `packages/shared/src/accounts` holds the isomorphic integration definitions (see the section below).

## Invariants

- `tokens`, `secrets` and `page-links` import `node:crypto`, so they are separate subpaths and are not exported from `index.ts`.
- Never import those subpaths from `apps/mobile` or from client components.
- Never move Node-only code into a module that `index.ts` re-exports.
- Keep zod schemas for stored or exported data optional or defaulted, so old exports and old rows still parse (`packages/shared/src/bundle.ts`).
- New workspace dependencies must also be added to the consumer bundlers (see the repo map in the root `AGENTS.md`).

## Why accounts are split in three

- `packages/shared/src/accounts`: definitions that both web and mobile can read (providers, scopes, tools, settings). It has no Node or database code.
- `packages/accounts`: OAuth flows and the encrypted token store. It needs Node, `node:crypto` and the database.
- `apps/worker/src/accounts`: runtime adapters that call Gmail, Calendar and Notion and serve the tools.
- The worker refuses to start if adapters and definitions disagree (`specProblem` in `apps/worker/src/accounts/registry.ts`).
- The step-by-step recipe is "Add an account provider" in the root `AGENTS.md`.

## Tests

- `pnpm --filter @open-bot/shared test` runs the Vitest suites next to the code.
- `pnpm --filter @open-bot/shared typecheck` checks types.

## Docs

- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/flows/accounts/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
