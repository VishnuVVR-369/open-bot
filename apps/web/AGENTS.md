<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

The Next.js app the owner uses: pages and components, server actions, the oRPC API that the browser and the mobile app read through, the SSE stream and file routes.
It does not run teammates or touch the computer; that is the worker (`apps/worker`) and botd (`apps/botd`), reached through the typed client in `apps/web/src/lib/server/worker.ts` (`workerContract`).
Shared types and the mobile contract belong in `packages/domain` and `packages/api`.

## Entry points

- `apps/web/src/app` is the App Router tree: `(app)` pages, `(auth)` sign-in, and `api/*` routes.
- `apps/web/src/lib/actions.ts` holds every server action (`"use server"`).
- `apps/web/src/app/api/stream/route.ts` is the SSE stream, fed by `apps/web/src/lib/server/realtime.ts`.
- `apps/web/src/app/api/rpc/[[...rest]]` serves the oRPC router in `apps/web/src/lib/server/api/router.ts` for the browser and mobile.
- `apps/web/src/lib/client/rpc.ts` is the browser's typed client (`api`) and its TanStack Query helpers (`orpc`); `apps/web/src/lib/client/errors.ts` tells offline, signed-out and not-found failures apart.
- `apps/web/src/proxy.ts` and `apps/web/src/instrumentation.ts` run at the edge of requests and at boot.
- `apps/web/next.config.ts` lists `transpilePackages` and the 41 MB server action body limit.

## Invariants

- Every non-test file in `apps/web/src/lib/server/` imports `server-only`.
- Files with `"use client"` must not import from `lib/server`.
- Browser reads go through the API with TanStack Query: a hook in `apps/web/src/lib/client/queries.ts` built from `orpc` (`apps/web/src/lib/client/rpc.ts`), never a server action, because server actions run one at a time per client.
- Query keys are procedure paths (`orpc.tasks.key()`); never write a key by hand.
  App events refresh queries by `APP_EVENT_REFRESHES` in `packages/api/src/events.ts`.
- Routes in `apps/web/src/app/api/*/route.ts` are only for streams, bytes (downloads, uploads, thumbnails), tokens and outside callers (webhooks, OAuth); a JSON read is a procedure.
- Server components read through functions in `apps/web/src/lib/server`, never `db` directly.
- Server actions are for writes and wrap their body in `guarded()` (`apps/web/src/lib/actions.ts`), which requires the user and returns `ActionResult`.
- Route handlers are wrapped in `authed()` (`apps/web/src/lib/server/route.ts`).
- Every oRPC procedure goes through the session middleware in `apps/web/src/lib/server/api/router.ts`.
- `apps/web/src/components/ui` is shadcn output (`apps/web/components.json`); do not edit it by hand, and eslint ignores it.
- A new workspace dependency must be added to `transpilePackages` in `apps/web/next.config.ts`.
- A new folder with generated types must be listed in `include` of `apps/web/tsconfig.json`, or `next dev` rewrites that file.
- Use "teammate" in new UI copy; `bots` and `botId` are legacy names (see the root AGENTS.md glossary).
- For recipes (new tool, setting, route), see "Where to make common changes" in the root `AGENTS.md`.

## Tests

- Unit: `pnpm --filter @open-bot/web test` (vitest, skips integration suites).
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
