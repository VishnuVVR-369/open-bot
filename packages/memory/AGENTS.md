# packages/memory

Versioned memory for teammates: saving, revisions, search and the background jobs that extract and embed.
Tool wiring and routes go in `apps/worker`, memory tables in `packages/db`, shared memory types in `packages/domain/src/memory/memory.ts`.

## Entry points

- `packages/memory/src/index.ts` (`.`): `MemoryService`, `MemoryError`, `MemoryActor`.
- `packages/memory/src/jobs.ts` (`./jobs`): the background jobs and `MemoryAIConfig` (embedding and extraction providers).

## Invariants

- Every write records who made it through a `MemoryActor` (user, import or a teammate with run id).
- Edits create revisions; items are not overwritten silently.
- Search combines full text with optional vector search; vectors are optional when no embedding provider is configured.
- Embedding and extraction calls respect `dailyRequestLimit`.
- Derived vectors are fenced by model and dimensions, so changing either means rebuilding them (see the embeddings table in `packages/db/src/schema.ts`).
- Queries go through Drizzle and the tables in `packages/db/src/schema.ts`, so a renamed column fails typecheck.
  Postgres-only parts (full text search, pgvector distance, `pg_notify`) are `sql` fragments with columns interpolated; user text is always a parameter.
  The search expression matches the `memory_items_search` index exactly; change both together.
- `MemoryService` takes the Drizzle database (`Db`). `addLessons` also takes a caller's transaction (`Tx`), so a new teammate's lessons commit with it.
- The `lessons` table, `bots.lessons_changed_at` and `settings.about_me` are projections rebuilt in the same transaction as each change.
  The two writes to other owners' tables are SQL text on purpose: Drizzle's `update` would also bump their `updated_at`.
  Their column names come from the schema (`sql.identifier(table.column.name)`), which the table-owners lint reads.
- Public `MemoryService` methods fail with the database's own error, never Drizzle's `DrizzleQueryError`, whose message repeats the SQL and its parameters (memory content).

## Tests

- `pnpm --filter @open-bot/memory test` runs unit tests and excludes integration suites.
- `pnpm test:integration` runs `packages/memory/src/memory.integration.test.ts` with the other suites.
- `pnpm test:memory` starts its own pgvector Postgres, runs the memory integration suite, smoke-tests the built worker, and with `--e2e` runs `e2e/memory.spec.ts` through `playwright.memory.config.ts`.

## Docs

- `apps/site/src/app/docs/flows/memory/page.mdx`
- `apps/site/src/app/docs/architecture/data/page.mdx`
