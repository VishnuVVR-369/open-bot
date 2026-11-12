# packages/db

The Drizzle schema, migrations, pool helpers, Postgres NOTIFY channels and app events.
Queries and business rules do not belong here; they live in the web server code, the worker services and `packages/memory`.
The one exception is the settings accessor, so the single settings row reads the same everywhere.
Better Auth's `account` table is sign-in and is unrelated to the integrations `accounts` table.

## Entry points

- `packages/db/src/index.ts`: `createPool`, `createDb`, `notify`, `CHANNELS`, `AppEvent`, `WorkerSignal`, plus the schema.
  `databaseError(error)` is the database's own error behind a `DrizzleQueryError`, for messages a person or a log sees.
- `packages/db/src/owners.ts`: who writes each table (see "One writer per table" below).
- `packages/db/src/locks.ts`: every advisory lock, by name in `LOCKS`, taken with `lockUntilCommit(tx, ...)` or `withTryLock(pool, ...)`.
  Never change a shipped key: the web app and the worker deploy separately and must still exclude each other.
- `packages/db/src/settings.ts`: `ownerSettings(db)` and `ownerTimeZone(db)`, the only way to read the settings row.
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

## One writer per table

- Every table has one owner in `packages/db/src/owners.ts`: the one module that inserts, updates and deletes its rows.
- Code that needs another table changed calls its owner: the web app through the worker's internal API, worker code through the owner's service or a function that takes the caller's transaction.
- Any server code may read any table. Phones and browsers never reach the database.
- The `open-bot/table-owners` lint rule (`scripts/lint/table-owners.mjs`) fails a Drizzle `insert`, `update` or `delete`, or raw SQL that writes a table, anywhere but its owner. Tests, seeds and stand-ins are exempt.
- `shared` lists columns another module sets in its own transaction, with the reason; the rule lets it set only those, and never delete.
  The list only shrinks, and `pnpm test:scripts` fails when an entry no longer writes its table.
- A new table needs an entry before it typechecks.

## Migration workflow

1. Edit `packages/db/src/schema.ts`, and give a new table its owner in `packages/db/src/owners.ts`.
2. Run `pnpm db:generate --name <snake_name>`.
3. Read the SQL. Add backfills by hand, separated by `--> statement-breakpoint`.
4. Run `pnpm db:migrate` locally, then `pnpm test:integration`.

## Tests

- This package has no tests of its own. `pnpm --filter @open-bot/db typecheck` checks types.
- `pnpm test:integration` applies every migration to a throwaway Postgres and runs all `*.integration.test.ts` suites (for example `packages/integrations/src/core/store.integration.test.ts` and `apps/worker/src/runs/dispatch.integration.test.ts`).

## Docs

- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/deployment/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
