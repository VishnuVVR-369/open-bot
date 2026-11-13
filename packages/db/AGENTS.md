# packages/db

The Drizzle schema, migrations, pool helpers, Postgres NOTIFY channels and app events.
Queries and business rules do not belong here; they live in the web server code, the worker services and `packages/memory`.
The one exception is the settings accessor, so the single settings row reads the same everywhere.
Better Auth's `account` table is sign-in and is unrelated to the integrations `accounts` table.

## Entry points

- `packages/db/src/index.ts`: `createPool`, `createDb`, `notify`, plus the schema.
- `packages/db/src/errors.ts`: a failed query never carries a value, because anything may log its error whole (our code, and Next.js or Better Auth for an error nobody caught).
  Drizzle's `DrizzleQueryError` never keeps the parameters (`patches/drizzle-orm@0.45.4.patch`); its message is the failed SQL.
  Every client of a pool from `createPool` rebuilds Postgres's error with `withoutValues`: no `detail`, `where`, `hint` or `internalQuery`, and a message that can quote a value (a data error, a raised exception, any SQLSTATE class not known to only name things) becomes `The database refused the query (SQLSTATE ...)`.
  So never make a pool with `new pg.Pool` in app code, and never log a query's parameters yourself.
  `errorMessage(error)` is what the database said, `errorFields(error)` a log line's fields (that message, the SQL, code, table, column, constraint), and `databaseError(error)` the database's own error to rethrow.
- `packages/db/src/owners.ts`: who writes each table (see "One writer per table" below).
- `packages/db/src/locks.ts`: every advisory lock, by name in `LOCKS`, taken with `lockUntilCommit(tx, ...)` or `withTryLock(pool, ...)`.
  Never change a shipped key: the web app and the worker deploy separately and must still exclude each other.
- `packages/db/src/settings.ts`: `ownerSettings(db)` and `ownerTimeZone(db)`, the only way to read the settings row.
- `@open-bot/db/schema` is `packages/db/src/schema/index.ts`, the single source of truth for tables: one file per area (`teammates.ts`, `chats.ts`, `runs.ts`, `integrations.ts`, `memory.ts`, ...), re-exported by `index.ts`, which drizzle-kit reads too.
  `packages/db/src/schema/columns.ts` holds the column helpers they share and is not exported.
  A schema file imports only the files of tables its foreign keys name, so the files never form a cycle.
- `@open-bot/db/testing` is `packages/db/src/testing.ts`: a fresh migrated database per integration suite.
- `packages/db/src/migrate.ts` applies `packages/db/drizzle/*.sql`; `packages/db/drizzle.config.ts` configures drizzle-kit.

## Invariants

- Migrations follow the recipe below: additive changes only, and a shipped migration is never edited.
- The NOTIFY channels (`NOTIFY_CHANNELS`: `openbot_chat`, `openbot_app` and `openbot_worker`), `AppEvent` and `WorkerSignal` live in `packages/domain/src/events`; `notify()` here sends on them. Adding an `AppEvent` also needs client invalidation (see "Add a realtime event" in `packages/domain/AGENTS.md`).
- `WorkerSignal` wakes the worker; a new value doesn't compile until the worker's `onSignal` (`apps/worker/src/index.ts`) handles it.
- `testing.ts` only writes to and drops databases named `openbot_test_*`.
- Upgrading `drizzle-orm` means remaking its patch (`pnpm patch drizzle-orm@<version>`); `pnpm install` fails while the patch names a version that is no longer installed.

## One writer per table

- Every table has one owner in `packages/db/src/owners.ts`: the one module that inserts, updates and deletes its rows.
- Code that needs another table changed calls its owner: the web app through the worker's internal API, worker code through the owner's service or a function that takes the caller's transaction.
- Any server code may read any table. Phones and browsers never reach the database.
- The `open-bot/table-owners` lint rule (`scripts/lint/table-owners.mjs`) fails a Drizzle `insert`, `update` or `delete`, or raw SQL that writes a table, anywhere but its owner. Tests, seeds and stand-ins are exempt.
- `shared` lists columns another module sets in its own transaction, with the reason; the rule lets it set only those, and never delete.
  The list only shrinks, and `pnpm test:scripts` fails when an entry no longer writes its table.
- A new table needs an entry before it typechecks.

## Recipes

Paths are relative to the repo root; symbols are in parentheses.

### Add a database table or column

1. Edit the area's file in `packages/db/src/schema/` (a new area gets a file, exported from `index.ts`).
   Keep changes additive (nullable or defaulted): the old web and worker keep running until the deploy finishes.
   A new table gets its owner, the one module that writes it, in `packages/db/src/owners.ts`; the `open-bot/table-owners` lint rule refuses writes anywhere else.
2. `pnpm db:generate --name <snake_name>` writes `packages/db/drizzle/<NNNN>_<name>.sql` plus the `meta/` snapshot and journal.
   Commit all three.
3. Read the SQL.
   Add backfills by hand before it ships, separated by `--> statement-breakpoint`.
   Never edit a migration that has shipped; add a new one.
4. `pnpm db:migrate` locally, then `pnpm test:integration`.
   On Railway the worker's pre-deploy step runs migrations; if one fails, Railway stays on the old commit.

## Tests

- `pnpm --filter @open-bot/db test` runs the unit tests, and `pnpm --filter @open-bot/db typecheck` checks types.
- `packages/db/src/errors.integration.test.ts` makes real queries fail and checks no value reaches their errors.
- `pnpm test:integration` applies every migration to a throwaway Postgres and runs all `*.integration.test.ts` suites (for example `packages/integrations/src/core/store.integration.test.ts` and `apps/worker/src/runs/dispatch.integration.test.ts`).

## Docs

- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/deployment/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
