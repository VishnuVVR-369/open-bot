# apps/worker

The always-on Node service that runs teammates: the run queue, agent tools, services, the internal HTTP API and the egress relay.
It does not render UI or hold user sessions (that is `apps/web`), and it does not run processes inside the computer (that is `apps/botd`).
Shared types and pure logic go in `packages/domain`, and schema changes go in `packages/db`.

## Entry points

- `apps/worker/src/index.ts`: process entry that builds the context, services and HTTP server.
- `apps/worker/src/http.ts`: the HTTP server, shared-secret auth and the raw upload route; `apps/worker/src/ws.ts` has the VNC and egress websockets.
- `apps/worker/src/rpc/router.ts`: the internal API (`workerContract` in `packages/api/src/worker/contract.ts`), each procedure calling a service; `apps/worker/src/rpc/handler.ts` wakes the computer around procedures that need it and maps errors (`apps/worker/src/rpc/errors.ts`).
- `apps/worker/src/features/<feature>/`: one folder per feature (list the folder to see which have moved): `service.ts`, its agent tools in `tools.ts`, its internal API procedures in `routes.ts`, any background work and web app signals it answers in `feature.ts` (a `Feature`, started from `apps/worker/src/index.ts`; add it to `FEATURES` in `apps/worker/src/shutdown.test.ts`), and `index.ts`, the only file code outside the folder imports (`apps/worker/src/features/boundaries.test.ts` checks it).
- `apps/worker/src/core/`: what features build on: `WorkerError`, the `Runtime`, the `Feature` manifest (`feature.ts`), row types, `defineTool()` (`tool.ts`) and the oRPC implementer (`rpc.ts`).
- `apps/worker/src/tools/`: registry infrastructure only: `definitions.ts` lists feature tools (`TOOLS`), `dependencies.ts` composes their services, and `handlers.ts` (`ToolHandlers.handle()`) finds the called tool by name and runs it. Feature tools use the single `defineTool()` in `apps/worker/src/core/tool.ts`. `DEVELOPER_INSTRUCTIONS` is in `apps/worker/src/instructions.ts`.
- `apps/worker/src/runs/`: sessions, execution, the live session registry (`registry.ts`), queuing, retries and run requests.
- `apps/worker/src/computer-lifecycle.ts` and `apps/worker/src/computer.ts`: computer sleep and wake, and `ComputerClient`, which calls botd through `botdContract` (`@open-bot/api/botd`) and validates every answer and event.
- `apps/worker/build.mjs`: esbuild bundle to `apps/worker/dist/worker.mjs`.

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

## Recipes

Paths are relative to the repo root; symbols are in parentheses.

### Add an agent tool (non-account)

1. One `defineTool({ name, description, input, helpers, handle })` in the feature's tools file: `apps/worker/src/features/<feature>/tools.ts`, using `defineTool()` from `apps/worker/src/core/tool.ts`.
   `input` is a zod object: Codex is offered its JSON schema, and a call is parsed with it before `handle` runs, so the handler gets typed `call.args` (`call.raw` is what Codex sent, for the timeline item).
   `helpers: "forbidden"` keeps swarm helpers from calling it.
   `handle` records a timeline item with `session.putItem(toolItem(...))` and calls `publishApp` if the UI shows the change.
   A new feature's file adds its list to `TOOLS` in `apps/worker/src/tools/definitions.ts`.
2. `pnpm --filter @open-bot/worker test -u` updates the tool list snapshot (`apps/worker/src/tools/__snapshots__/tools.json`); review its diff.
   Nothing to bump: threads started with other tools or instructions are replaced by fresh ones (`apps/worker/src/runs/tools-revision.ts`).
3. A new tool dependency is composed in `ToolRegistryServices` (`apps/worker/src/tools/dependencies.ts`), passed by name in `apps/worker/src/index.ts`.
   A feature's tools declare only the services they use (`TaskToolDeps` in `apps/worker/src/features/tasks/tools.ts`).
4. Optional: rules in `DEVELOPER_INSTRUCTIONS` (`apps/worker/src/instructions.ts`), an icon, or `asksApproval` for a tool whose call is itself the approval request, in `TOOL_DISPLAY` (`packages/domain/src/timeline/tool-display.ts`), which web and mobile both read.
   A new icon meaning needs its icon in `apps/web/src/features/chat/components/items.tsx` and `apps/mobile/src/components/chat/tool-icons.ts`.
5. Document it in `apps/site/src/app/docs/reference/tools/page.mdx`.

### Add a worker internal route (called by web)

1. `packages/api/src/worker/contracts/<feature>.ts` (composed in `packages/api/src/worker/contract.ts`): add a procedure to `workerContract` with its `route` (`/internal/...`), input and output schemas.
   Use `computer` instead of `base` if it touches the computer, or it will not wake it; never for a status read.
2. `apps/worker/src/features/<feature>/routes.ts`: implement it by calling the feature service; export the route builder from its `index.ts` and compose it in `apps/worker/src/rpc/router.ts`.
   Put rules in the service, and throw the service's own error class, which extends `WorkerError` (`apps/worker/src/core/errors.ts`) with a status; `apps/worker/src/rpc/errors.ts` turns it into the answer in one place.
   Auth (`x-worker-secret`) is automatic.
3. Call it from web with the typed client: `worker.<domain>.<procedure>(input)` (`apps/web/src/lib/server/worker.ts`) in a feature's `server/` folder (`apps/web/src/features/<feature>/server/`).
   Failures are `WorkerError` with the worker's status and message.
4. Document it in `apps/site/src/app/docs/reference/http-api/page.mdx`.

## Tests

- Unit: `pnpm --filter @open-bot/worker test`.
- Integration: `pnpm test:integration` from the root (starts Postgres), or `pnpm --filter @open-bot/worker test:integration` with `TEST_DATABASE_URL` set.
- Shared tool test setup: `apps/worker/src/testing/tools.ts`, with a fresh database per feature suite and the same per-test reset.
- Shared HTTP test setup: `apps/worker/src/testing/rpc.ts`; feature-local suites each get their own throwaway database and server.
- Integration suites: the `*.integration.test.ts` files under `apps/worker/src` (`git ls-files 'apps/worker/**/*.integration.test.ts'`).
- Built artifact: `pnpm --filter @open-bot/worker build && node apps/worker/dist/worker.mjs`.
- Sleep and wake: `pnpm test:computer-sleep`.
- E2E: `pnpm e2e` (for example `e2e/agent.spec.ts`, `e2e/computer.spec.ts`, `e2e/swarm.spec.ts`).

## Docs

- `apps/site/src/app/docs/architecture/worker/page.mdx`
- `apps/site/src/app/docs/architecture/agent-runtime/page.mdx`
- `apps/site/src/app/docs/reference/tools/page.mdx`
- `apps/site/src/app/docs/reference/http-api/page.mdx`
