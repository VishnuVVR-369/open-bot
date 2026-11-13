# apps/worker

The always-on Node service that runs teammates: the run queue, agent tools, services, the internal HTTP API and the egress relay.
It does not render UI or hold user sessions (that is `apps/web`), and it does not run processes inside the computer (that is `apps/botd`).
Shared types and pure logic go in `packages/domain`, and schema changes go in `packages/db`.

## Entry points

- `apps/worker/src/index.ts`: process entry that builds the context, services and HTTP server.
- `apps/worker/src/http.ts`: the HTTP server, shared-secret auth and the raw upload route; `apps/worker/src/ws.ts` has the VNC and egress websockets.
- `apps/worker/src/rpc/router.ts`: the internal API (`workerContract` in `packages/api/src/worker/contract.ts`), each procedure calling a service; `apps/worker/src/rpc/handler.ts` wakes the computer around procedures that need it and maps errors (`apps/worker/src/rpc/errors.ts`).
- `apps/worker/src/features/<feature>/`: a feature moved into its own folder (so far `tasks`, `teammates`, `pages` and `automations`): `service.ts`, its agent tools in `tools.ts`, its internal API procedures in `routes.ts`, any background work and web app signals it answers in `feature.ts` (a `Feature`, started from `apps/worker/src/index.ts`; add it to `FEATURES` in `apps/worker/src/shutdown.test.ts`), and `index.ts`, the only file code outside the folder imports (`apps/worker/src/features/boundaries.test.ts` checks it).
- `apps/worker/src/core/`: what features build on: `WorkerError`, the `Runtime`, the `Feature` manifest (`feature.ts`), row types, `defineTool()` (`tool.ts`) and the oRPC implementer (`rpc.ts`).
- `apps/worker/src/tools/`: one file per feature not yet moved defines its tools with `defineTool()` (`define.ts`): name, description, zod input, helper policy and handler. `definitions.ts` lists them (`TOOLS`), and `handlers.ts` (`ToolHandlers.handle()`) finds the called tool by name and runs it. `DEVELOPER_INSTRUCTIONS` is in `apps/worker/src/instructions.ts`.
- `apps/worker/src/computer-lifecycle.ts` and `apps/worker/src/computer.ts`: computer sleep and wake, and `ComputerClient`, which calls botd through `botdContract` (`@open-bot/api/botd`) and validates every answer and event.
- `apps/worker/build.mjs`: esbuild bundle to `apps/worker/dist/worker.mjs`.
- For adding a tool, route, account or event, see "Where to make common changes" in the root `AGENTS.md`.

## Invariants

- A Codex thread keeps the tools and `DEVELOPER_INSTRUCTIONS` it started with, so `bot_threads.tools_revision` hashes both (`apps/worker/src/runs/tools-revision.ts`), and a change starts fresh threads. There is nothing to bump.
- `apps/worker/build.mjs` keeps only Node built-ins and the worker's own declared dependencies external, and bundles everything else.
- A new import in a workspace package may need a dependency declared here or it is bundled, so run the built artifact.
- Procedures that touch the computer must be marked `wakesComputer` (the `computer` builder) in `packages/api/src/worker/contract.ts`, or they will not wake it.
- Internal API paths and input fields stay until no deployed web app calls them: the web app and the worker deploy separately.
- The lifecycle does no idle polling of the computer, and reading status must not wake it.
- A timer, listener or connection started in `apps/worker/src/index.ts` registers its stop with the `Runtime` (`apps/worker/src/core/runtime.ts`), which stops everything in reverse at shutdown.
- A request the worker refuses throws a `WorkerError` subclass (`apps/worker/src/core/errors.ts`); `apps/worker/src/core/errors.test.ts` fails on a new error class that doesn't extend it.
- Row types shared across runs, services and tools (`Bot`, `Chat`, `Run`) are in `apps/worker/src/core/db-types.ts`.
- `RunEventWriter` is the only way a session writes run events.
- Swarm helpers are refused tools defined with `helpers: "forbidden"`; `apps/worker/src/tools/catalog.test.ts` lists them.
- The worker refuses to start if account adapters and their definitions disagree (`packages/integrations/src/integration-registry.ts`).

## Tests

- Unit: `pnpm --filter @open-bot/worker test`.
- Integration: `pnpm test:integration` from the root (starts Postgres), or `pnpm --filter @open-bot/worker test:integration` with `TEST_DATABASE_URL` set.
- Integration suites: all nine `*.integration.test.ts` files under `apps/worker/src` (`git ls-files 'apps/worker/**/*.integration.test.ts'`).
- Built artifact: `pnpm --filter @open-bot/worker build && node apps/worker/dist/worker.mjs`.
- Sleep and wake: `pnpm test:computer-sleep`.
- E2E: `pnpm e2e` (for example `e2e/agent.spec.ts`, `e2e/computer.spec.ts`, `e2e/swarm.spec.ts`).

## Docs

- `apps/site/src/app/docs/architecture/worker/page.mdx`
- `apps/site/src/app/docs/architecture/agent-runtime/page.mdx`
- `apps/site/src/app/docs/reference/tools/page.mdx`
- `apps/site/src/app/docs/reference/http-api/page.mdx`
