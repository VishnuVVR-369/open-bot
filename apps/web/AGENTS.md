<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

The Next.js app the owner uses: pages and components, the oRPC API that the browser and the mobile app read and write through, the SSE stream and file routes.
It does not run teammates or touch the computer; that is the worker (`apps/worker`) and botd (`apps/botd`), reached through the typed client in `apps/web/src/lib/server/worker.ts` (`workerContract`).
Shared types and the mobile contract belong in `packages/domain` and `packages/api`.

## Entry points

- `apps/web/src/app` is the App Router tree: `(app)` pages, `(auth)` sign-in, and `api/*` routes.
- `apps/web/src/features/<feature>/` holds a feature that has moved into its own folder (so far `tasks`, `vault`, `skills`, `files`, `memory`, `pages`, `approvals`, `home`, `computer`, `automations` and `teammates`): its views in `components/`, its hooks in `hooks.ts`, and its server side (reads in `server/queries.ts`, or a `server/service.ts` when it also changes things, and API procedures in `server/routes.ts`).
  Code outside the folder imports only its `index.ts` (client side) or `server.ts` (server side); `apps/web/src/features/boundaries.test.ts` checks it.
  Nothing `index.ts` reaches may import server code (`server-only`, `@open-bot/db`, a package's `/server` entry), since a client component that imports it puts it in the browser; the same test checks that too.
- `apps/web/src/lib/server/api/` has the API's services: what a procedure does beyond calling the worker, such as `integrations.ts` (connections, accounts, email) and `settings.ts`.
- `apps/web/src/app/api/stream/route.ts` is the SSE stream, fed by `apps/web/src/lib/server/realtime.ts`.
- `apps/web/src/app/api/rpc/[[...rest]]` serves the oRPC router in `apps/web/src/lib/server/api/router.ts` for the browser and mobile; features build their procedures with `os` from `apps/web/src/lib/server/api/rpc.ts`, which checks the session and maps errors.
- `apps/web/src/lib/client/rpc.ts` is the browser's typed client (`api`) and its TanStack Query helpers (`orpc`); `apps/web/src/lib/client/errors.ts` tells offline, signed-out and not-found failures apart.
- `apps/web/src/lib/client/mutate.ts` has `attempt()` for writes, and `apps/web/src/lib/client/uploads.ts` uploads attachments and files.
- `apps/web/src/proxy.ts` and `apps/web/src/instrumentation.ts` run at the edge of requests and at boot.
- `apps/web/next.config.ts` lists `transpilePackages`.

## Invariants

- Every non-test file in `apps/web/src/lib/server/`, and in a feature's `server.ts` and `server/`, imports `server-only`.
- Files with `"use client"` must not import from `lib/server` or a feature's server side.
- Browser reads go through the API with TanStack Query: a hook in the feature's `hooks.ts` (or `apps/web/src/lib/client/queries.ts` for areas not moved yet) built from `orpc` (`apps/web/src/lib/client/rpc.ts`).
- Query keys are procedure paths (`orpc.tasks.key()`); never write a key by hand.
  App events refresh queries by `APP_EVENT_REFRESHES` in `packages/api/src/events.ts`.
- Routes in `apps/web/src/app/api/*/route.ts` are only for streams, bytes (downloads, uploads, thumbnails), tokens and outside callers (webhooks, OAuth); a JSON read is a procedure.
- Server components read through functions in `apps/web/src/lib/server` or a feature's `server.ts`, never `db` directly.
- Browser writes go through the API too: `attempt(api.chats.archive({ chatId }))` (`apps/web/src/lib/client/mutate.ts`) returns `{ ok, data }` or `{ ok, error }`.
  A new write is a procedure in `packages/api/src/contract.ts` with its handler in `apps/web/src/lib/server/api/router.ts`, never a server action: those run one at a time per client and the phone can't call them.
  `apps/web/src/no-server-actions.test.ts` fails on any `"use server"`.
- A service throws `ApiError` (`apps/web/src/lib/server/api/errors.ts`) for a refusal you see, with a code the router turns into the API's error and status.
- Route handlers are wrapped in `authed()` (`apps/web/src/lib/server/route.ts`), which also refuses writes from other sites.
  A route that takes writes without `authed()` must be listed, with why, in `apps/web/src/app/api/routes.test.ts`.
- Every oRPC procedure is built with `os` from `apps/web/src/lib/server/api/rpc.ts`, so it goes through the session middleware there.
- `apps/web/src/components/ui` is shadcn output (`apps/web/components.json`); do not edit it by hand, and eslint ignores it.
- A new workspace dependency must be added to `transpilePackages` in `apps/web/next.config.ts`.
- `apps/web/tsconfig.json` extends `tsconfig.base.json`, so the app is type-checked as strictly as the packages, and Next.js never edits it.
  A new folder with generated types (a new `distDir`) must be added to its `include` by hand, or its route types go unchecked.
- Use "teammate" in new UI copy; `bots` and `botId` are legacy names (see the root AGENTS.md glossary).
- For recipes (new tool, setting, route), see "Where to make common changes" in the root `AGENTS.md`.

## Tests

- Unit: `pnpm --filter @open-bot/web test` (vitest, skips integration suites), including the cross-site checks in `apps/web/src/app/api/routes.test.ts` and `apps/web/src/app/api/rpc/[[...rest]]/route.test.ts`.
- Types: `pnpm --filter @open-bot/web typecheck`.
- Integration: `pnpm test:integration` runs `apps/web/src/lib/server/egress-device.integration.test.ts` and `apps/web/src/lib/server/api/router.integration.test.ts` (every API read) against a throwaway Postgres.
- End to end: `pnpm e2e` runs the Playwright specs in `e2e/` against a local stack, for example `e2e/pocket-inbox.spec.ts` and `e2e/api.spec.ts`.
- Built artifact: `pnpm --filter @open-bot/web build` when you touch bundling, `next.config.ts` or dependencies.
- UI changes also follow the openbot-ui-review skill.

## Docs

- `apps/site/src/app/docs/architecture/web-app/page.mdx`
- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/security/page.mdx`
- `apps/site/src/app/docs/flows/chat-turn/page.mdx`
