# apps/pages

A small Node service that serves published pages on an origin of their own, behind short links the web app signs.
It does not render the app UI, publish pages or know who the owner is: publishing is in `apps/worker/src/features/pages/`, and page CSS, JS and libraries are in `packages/page-kit`.

## Entry points

- `apps/pages/src/index.ts`: process entry that opens the database and listens on `PORT` (3400).
- `apps/pages/src/env.ts`: `readEnv()`, the only place the service reads the environment (`DATABASE_URL`, `PAGES_SECRET`, `PAGES_URL`, `APP_URL`, `PAGE_LIB_DIR`, `PORT`).
- `apps/pages/src/server.ts`: `createPagesHandler()` with `/healthz`, `/lib/*` and `/v/<uuid>?k=...`.
- `apps/pages/build.mjs`: esbuild bundle to `apps/pages/dist/pages.mjs`, then copies the page-kit libraries to `apps/pages/dist/lib`.

## Invariants

- Pages stay on a service and origin of their own, never a route in the web app, so a page's scripts can never see the owner's session.
- Pages never need to know who the owner is; access is a short signed link checked with `verifyPageVersion()`.
- It reads only `html` and `sha256` from `page_versions`, by id, and only after the key checks out.
- A published version is immutable.
- Only GET and HEAD are served; everything else is 405 or 404.
- `frame-ancestors` allows only the origins in `APP_URL`.
- The page runtime is injected at serve time and never stored with a version.
- `PAGES_SECRET` must be at least 32 characters and the same value as the web app's.
- `build.mjs` bundles everything, and the build fails if anything but Node built-ins would be imported at runtime.
- Page links come from `@open-bot/domain/server`, which is Node-only: fine here but never in client code.

## Tests

- `pnpm --filter @open-bot/pages test` and `pnpm --filter @open-bot/pages typecheck`.
- Unit suite: `apps/pages/src/server.test.ts`.
- Built artifact: `pnpm --filter @open-bot/pages build && node apps/pages/dist/pages.mjs`.
- E2E: `e2e/pages.spec.ts`.
- Related integration suite: `apps/worker/src/features/pages/service.integration.test.ts`.

## Docs

- `apps/site/src/app/docs/architecture/pages/page.mdx`
- `apps/site/src/app/docs/flows/pages/page.mdx`
- `apps/site/src/app/docs/security/page.mdx`
