<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/site

The public landing page and the technical docs, built as a static Next.js export and deployed to Cloudflare.
It is separate from `apps/web`, the private app, and shares no runtime code with it.
Product behavior belongs in the other workspaces; this one only describes it.

## Entry points

- `apps/site/src/app/page.tsx` is the landing page; `apps/site/src/lib/tour.ts` lists the tour chapters.
- `apps/site/src/app/docs/**/page.mdx` are the docs pages, laid out by `apps/site/src/app/docs/layout.tsx`.
- `apps/site/src/lib/docs.ts` is the docs nav list: sidebar, previous/next links, metadata and sitemap all come from it.
- `apps/site/next.config.ts` configures the static export (`out/`) and MDX.
- `apps/site/wrangler.jsonc` deploys `out/` as a Cloudflare Worker with static assets.
- `apps/site/scripts/write-headers.mjs` writes `out/_headers` after `next build`.

## Invariants

- A new docs page needs its `page.mdx` and an entry in `apps/site/src/lib/docs.ts`.
- Cloudflare builds this site only when a push changes it (build watch paths, see `apps/site/README.md`), and a red Cloudflare check is a real failure.
- If the site starts importing a workspace package or another repo file, add that path to the watch paths.
- The output is static; do not add server-only features.
- The tour stream lives in a Cloudflare R2 bucket, not in `apps/site/public/media`.
- Update the matching docs page when behavior elsewhere changes (see "Architecture docs" in the root `AGENTS.md`).

## Tests

- Types: `pnpm --filter @open-bot/site typecheck`.
- End to end: `pnpm --filter @open-bot/site test:e2e` (`apps/site/e2e/site.spec.ts`, `apps/site/e2e/docs.spec.ts`).
- The e2e run needs the encoded tour first: `pnpm --filter @open-bot/site media:encode`.
- Built artifact: `pnpm --filter @open-bot/site build`, then check `out/` and `out/_headers`.
- No `*.integration.test.ts` suites cover this workspace.

## Docs

- `apps/site/README.md`
- `apps/site/src/app/docs/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
