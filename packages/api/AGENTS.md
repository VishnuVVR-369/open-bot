# packages/api

The oRPC contracts: the API the web app serves to its browser pages and the Android app, the worker's internal API the web app calls, and botd's API the worker calls.
It holds shapes only, with no handlers.
Handlers go in `apps/web/src/lib/server/api/router.ts` and the queries behind them in `apps/web`.
Shared domain logic goes in `packages/domain`.

## Entry points

- `@open-bot/api` is `packages/api/src/index.ts`: the app's contract, views, client and event refresh map.
- `@open-bot/api/worker` is `packages/api/src/worker/index.ts`: `workerContract`, the worker's views and `createWorkerClient`. The phone never imports it.
- `@open-bot/api/botd` is `packages/api/src/botd/index.ts`: `botdContract`, `BOTD_SOCKETS` and `createBotdClient`. botd implements it in `apps/botd/src/router.ts`; only the worker calls it.
- `@open-bot/api/desktop` is `packages/api/src/desktop.ts`: what the desktop app gets from `/api/desktop/egress-token`. It imports only zod, so the Electron bundle stays small.
- `packages/api/src/contract.ts` is the oRPC contract, grouped by namespace; `packages/api/src/base.ts` has its error map and shared input pieces.
- `packages/api/src/views.ts` has the view schemas (`botSummarySchema`, `chatDataSchema`, ...); feature files (`home.ts`, `automations.ts`, `teammates.ts`, `integrations.ts`, `settings.ts`, `skills.ts`, `tasks.ts`, `vault.ts`, `memory.ts`) have the rest.
- `packages/api/src/events.ts` has `APP_EVENT_REFRESHES`: which procedures each app event refreshes.
  The web app applies it in `apps/web/src/lib/client/refresh.ts`.
- `packages/api/src/client.ts` has `createApiClient`, a typed client for `<appUrl>/api/rpc`.
- `packages/api/src/live.ts` has the server-sent event parser and the chat stream types.
- `packages/api/src/screens.ts` and `packages/api/src/egress.ts` have the screen and egress views.

## Invariants

- Everything exported must be serializable and safe for React Native, with no Node imports.
- The only dependencies are `@open-bot/domain`, zod and oRPC.
- Adding a procedure needs a handler in `apps/web/src/lib/server/api/router.ts`, for `workerContract` in `apps/worker/src/rpc/router.ts`, or for `botdContract` in `apps/botd/src/router.ts`.
- `workerContract` paths are fixed REST paths that old deployed web apps still call: keep them, and keep input fields, until none does. The same holds for `botdContract` and deployed workers.
- Schemas for botd's wire shapes (health, leases, events, action results) live in `packages/domain/src/computer/protocol.ts`; the contract composes them.
- The worker bundler resolves this package for its types, so new deps must be declared (`apps/worker/build.mjs`).
- The stream format in `live.ts` is a public contract with the phone: do not change event names without shipping both sides.

## Tests

- `pnpm --filter @open-bot/api test` runs `packages/api/src/live.test.ts` and any other unit tests.
- `apps/web/src/lib/server/api/router.integration.test.ts` calls every read through the web router on a throwaway database, so a view that disagrees with its query fails there.
- `pnpm --filter @open-bot/api typecheck` checks types.
- `e2e/api.spec.ts` drives the contract through the real stack.
- `apps/worker/src/rpc/handler.test.ts` and `apps/worker/src/rpc/router.integration.test.ts` drive `workerContract` through the worker's HTTP server.
- `apps/botd/src/contract.test.ts` drives `botdContract` through botd's server, and `apps/worker/src/computer.test.ts` drives the worker's client against a stand-in botd.

## Docs

- `apps/site/src/app/docs/reference/http-api/page.mdx`
- `apps/site/src/app/docs/architecture/web-app/page.mdx`
- See "Add a mobile screen" in the root `AGENTS.md` for the files a new procedure touches.
