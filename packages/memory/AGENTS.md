# packages/memory

Versioned memory for teammates: saving, revisions, search and the background jobs that extract and embed.
Tool wiring and routes go in `apps/worker`, memory tables in `packages/db`, shared memory types in `packages/shared/src/memory.ts`.

## Entry points

- `packages/memory/src/index.ts` (`.`): `MemoryService`, `MemoryError`, `MemoryActor`.
- `packages/memory/src/jobs.ts` (`./jobs`): the background jobs and `MemoryAIConfig` (embedding and extraction providers).

## Invariants

- Every write records who made it through a `MemoryActor` (user, import or a teammate with run id).
- Edits create revisions; items are not overwritten silently.
- Search combines full text with optional vector search; vectors are optional when no embedding provider is configured.
- Embedding and extraction calls respect `dailyRequestLimit`.
- Derived vectors are fenced by model and dimensions, so changing either means rebuilding them (see the embeddings table in `packages/db/src/schema.ts`).
- Queries use `pg` directly with parameters; keep user text out of SQL strings.

## Tests

- `pnpm --filter @open-bot/memory test` runs unit tests and excludes integration suites.
- `pnpm test:integration` runs `packages/memory/src/memory.integration.test.ts` with the other suites.
- `pnpm test:memory` starts its own pgvector Postgres, runs the memory integration suite, smoke-tests the built worker, and with `--e2e` runs `e2e/memory.spec.ts` through `playwright.memory.config.ts`.

## Docs

- `apps/site/src/app/docs/flows/memory/page.mdx`
- `apps/site/src/app/docs/architecture/data/page.mdx`
