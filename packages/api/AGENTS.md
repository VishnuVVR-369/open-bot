# packages/api

The oRPC contracts: the API the web app serves to the Android app, and the worker's internal API the web app calls.
It holds shapes only, with no handlers.
Handlers go in `apps/web/src/lib/server/api/router.ts` and the queries behind them in `apps/web`.
Shared domain logic goes in `packages/domain`.

## Entry points

- `@open-bot/api` is `packages/api/src/index.ts`: the phone's contract, views and client.
- `@open-bot/api/worker` is `packages/api/src/worker/index.ts`: `workerContract`, the worker's views and `createWorkerClient`. The phone never imports it.
- `packages/api/src/contract.ts` is the oRPC contract, one procedure per mobile call.
- `packages/api/src/views.ts` has the view schemas (`botSummarySchema`, `chatDataSchema`, ...).
- `packages/api/src/client.ts` has `createApiClient`, a typed client for `<appUrl>/api/rpc`.
- `packages/api/src/live.ts` has the server-sent event parser and the chat stream types.
- `packages/api/src/screens.ts` and `packages/api/src/egress.ts` have the screen and egress views.

## Invariants

- Everything exported must be serializable and safe for React Native, with no Node imports.
- The only dependencies are `@open-bot/domain`, zod and oRPC.
- Adding a procedure needs a handler in `apps/web/src/lib/server/api/router.ts`, or for `workerContract` in `apps/worker/src/rpc/router.ts`.
- `workerContract` paths are fixed REST paths that old deployed web apps still call: keep them, and keep input fields, until none does.
- The worker bundler resolves this package for its types, so new deps must be declared (`apps/worker/build.mjs`).
- The stream format in `live.ts` is a public contract with the phone: do not change event names without shipping both sides.

## Tests

- `pnpm --filter @open-bot/api test` runs `packages/api/src/live.test.ts` and any other unit tests.
- `pnpm --filter @open-bot/api typecheck` checks types.
- `e2e/api.spec.ts` drives the contract through the real stack.
- `apps/worker/src/rpc/handler.test.ts` and `apps/worker/src/rpc/router.integration.test.ts` drive `workerContract` through the worker's HTTP server.

## Docs

- `apps/site/src/app/docs/reference/http-api/page.mdx`
- `apps/site/src/app/docs/architecture/web-app/page.mdx`
- See "Add a mobile screen" in the root `AGENTS.md` for the files a new procedure touches.
