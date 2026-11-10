# packages/db

The Drizzle schema, migrations, pool helpers, Postgres NOTIFY channels and app events.
Queries and business rules do not belong here; they live in the web server code, the worker services and `packages/memory`.
Better Auth's `account` table is sign-in and is unrelated to the integrations `accounts` table.

## Entry points

- `packages/db/src/index.ts`: `createPool`, `createDb`, `notify`, `CHANNELS`, `AppEvent`, `WorkerSignal`, plus the schema.
- `packages/db/src/upload-locks.ts` and `packages/db/src/team-lock.ts`: advisory locks the web app and the worker share.
  `lockTeam` is taken by creating and archiving a teammate and by choosing the lead; keep its key, since the two deploy separately.
- `@open-bot/db/schema` is `packages/db/src/schema.ts`, the single source of truth for tables.
- `@open-bot/db/testing` is `packages/db/src/testing.ts`: a fresh migrated database per integration suite.
- `packages/db/src/migrate.ts` applies `packages/db/drizzle/*.sql`; `packages/db/drizzle.config.ts` configures drizzle-kit.

## Invariants

- Never edit a migration that has shipped; add a new one.
- Keep schema changes additive (nullable or defaulted), because the old web and worker keep running until the deploy finishes.
- The worker's Railway pre-deploy step runs migrations. If one fails, Railway stays on the old commit.
- Commit the SQL, `packages/db/drizzle/meta/` snapshot and journal together.
- `CHANNELS` are `openbot_chat`, `openbot_app` and `openbot_worker`. Adding an `AppEvent` also needs client invalidation (see "Add a realtime event" in the root `AGENTS.md`).
- `WorkerSignal` wakes the worker; a new value needs a listener in the worker.
- `testing.ts` only writes to and drops databases named `openbot_test_*`.

## Migration workflow

1. Edit `packages/db/src/schema.ts`.
2. Run `pnpm db:generate --name <snake_name>`.
3. Read the SQL. Add backfills by hand, separated by `--> statement-breakpoint`.
4. Run `pnpm db:migrate` locally, then `pnpm test:integration`.

## Tests

- This package has no tests of its own. `pnpm --filter @open-bot/db typecheck` checks types.
- `pnpm test:integration` applies every migration to a throwaway Postgres and runs all `*.integration.test.ts` suites (for example `packages/accounts/src/store.integration.test.ts` and `apps/worker/src/runs/dispatch.integration.test.ts`).

## Docs

- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/deployment/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
