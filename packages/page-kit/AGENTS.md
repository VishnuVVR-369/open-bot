# packages/page-kit

What every page can load: the runtime, the page kit CSS and JS, fonts, vendored libraries, and the built-in `/page` skill.
Serving pages and signing links go in `apps/pages` and `packages/domain/src/server/page-links.ts`, and page storage goes in the worker.

## Entry points

- `packages/page-kit/src/index.ts` (`.`): `PAGE_KIT` and `PAGE_LIBRARIES`.
- `packages/page-kit/src/serve.ts` (`./serve`): Node-only `/lib` file serving, shared by `apps/pages` and the computer's preview server.
- `packages/page-kit/src/skill.ts` (`./skill`): the `/page` skill text, built from `PAGE_LIBRARIES` and `packages/page-kit/src/template.ts`.
- `packages/page-kit/scripts/build.mjs` assembles `packages/page-kit/dist/lib`, which is gitignored.

## Invariants

- Pages run on their own origin with a strict CSP that only allows `/lib/` scripts, so libraries are vendored, never loaded from a CDN.
- Library versions in `package.json` are exact; `build.mjs` copies files from `node_modules`.
- Kit assets are versioned by path (`kit@1`); a breaking change needs a new path.
- `./serve` imports Node modules; do not import it from the web client.
- The computer image bundles page-kit too, so changes require a computer redeploy.
- `apps/pages/build.mjs` reads `packages/page-kit/dist/lib`, so build page-kit first.
- Libraries are the extension point; pages have no type.

## Tests

- `pnpm --filter @open-bot/page-kit test` builds first (see `packages/page-kit/turbo.json`) and then runs `packages/page-kit/src/kit.test.ts` against `dist/lib`.
- Built-artifact check: `pnpm --filter @open-bot/pages build && node apps/pages/dist/pages.mjs`.
- `pnpm test:integration` includes `apps/worker/src/services/pages.integration.test.ts`; `e2e/pages.spec.ts` covers the full stack.
- See "Add a page-kit library" in the root `AGENTS.md`.

## Docs

- `apps/site/src/app/docs/architecture/pages/page.mdx`
- `apps/site/src/app/docs/flows/pages/page.mdx`
