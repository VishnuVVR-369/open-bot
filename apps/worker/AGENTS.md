# apps/worker

The always-on Node service that runs teammates: the run queue, agent tools, services, the internal HTTP API and the egress relay.
It does not render UI or hold user sessions (that is `apps/web`), and it does not run processes inside the computer (that is `apps/botd`).
Shared types and pure logic go in `packages/shared`, and schema changes go in `packages/db`.

## Entry points

- `apps/worker/src/index.ts`: process entry that builds the context, services and HTTP server.
- `apps/worker/src/http.ts`: internal routes (`routes` in `createHttpServer`), shared-secret auth and the `computerOperation` wake rule.
- `apps/worker/src/tools/definitions.ts` and `apps/worker/src/tools/handlers.ts`: tool specs (`TOOLS_VERSION`) and `ToolHandlers.handle()`, with `DEVELOPER_INSTRUCTIONS` in `apps/worker/src/instructions.ts`.
- `apps/worker/src/computer-lifecycle.ts` and `apps/worker/src/computer.ts`: computer sleep and wake, and the client for botd.
- `apps/worker/build.mjs`: esbuild bundle to `apps/worker/dist/worker.mjs`.
- For adding a tool, route, account or event, see "Where to make common changes" in the root `AGENTS.md`.

## Invariants

- Bump `TOOLS_VERSION` whenever tool definitions or `DEVELOPER_INSTRUCTIONS` change, or existing threads keep the old set.
- `apps/worker/build.mjs` keeps only Node built-ins and the worker's own declared dependencies external, and bundles everything else.
- A new import in a workspace package may need a dependency declared here or it is bundled, so run the built artifact.
- Routes that touch the computer must match `computerOperation` in `apps/worker/src/http.ts`, or they will not wake it.
- The lifecycle does no idle polling of the computer, and reading status must not wake it.
- `RunEventWriter` is the only way a session writes run events.
- Swarm helpers are refused tools listed in `HELPER_FORBIDDEN`.
- The worker refuses to start if account adapters and their shared definitions disagree (`apps/worker/src/accounts/registry.ts`).

## Tests

- Unit: `pnpm --filter @open-bot/worker test`.
- Integration: `pnpm test:integration` from the root (starts Postgres), or `pnpm --filter @open-bot/worker test:integration` with `TEST_DATABASE_URL` set.
- Integration suites: all eight `*.integration.test.ts` files under `apps/worker/src` (`git ls-files 'apps/worker/**/*.integration.test.ts'`).
- Built artifact: `pnpm --filter @open-bot/worker build && node apps/worker/dist/worker.mjs`.
- Sleep and wake: `pnpm test:computer-sleep`.
- E2E: `pnpm e2e` (for example `e2e/agent.spec.ts`, `e2e/computer.spec.ts`, `e2e/swarm.spec.ts`).

## Docs

- `apps/site/src/app/docs/architecture/worker/page.mdx`
- `apps/site/src/app/docs/architecture/agent-runtime/page.mdx`
- `apps/site/src/app/docs/reference/tools/page.mdx`
- `apps/site/src/app/docs/reference/http-api/page.mdx`
