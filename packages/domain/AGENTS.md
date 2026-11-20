# packages/domain

Isomorphic types, zod schemas and pure logic used by web, worker, mobile and the other packages.
It must stay runnable in a browser and in React Native.
Database access goes in `packages/db`, OAuth and token storage in `packages/integrations`, runtime behavior in the apps.

## Layout

One folder per feature under `packages/domain/src`, each with an `index.ts` barrel:

- `teammates`: profile options, creation and edit schemas (`management.ts`), export bundles, templates, status.
- `computer`: botd's wire protocol (`protocol.ts`), screen operations, disk paths, file kinds.
- `egress`: the owner's settings for which devices carry the browser's traffic.
- `events`: the app events announced to open tabs and phones (`appEventSchema`).
- `timeline`: run timeline items and their reducer.
- `approvals`: always-allow rules, how approvals are shown, and the job-application guard.
- `automations`: schedules and triggers.
- `integrations`: MCP connections and the OAuth account definitions (`integrations/accounts`).
- `chats`: chat kinds, message roles, reply ratings and upload statuses.
- `tasks`: the task board's statuses.
- `pages`, `skills`, `memory`, `vault`, `models`, `channels` (Telegram, email, phone pushes), `auth` (password, recovery) and `text`.
- `server`: Node-only helpers, see below.

## Entry points

- `@open-bot/domain` is `packages/domain/src/index.ts`, which re-exports every feature folder except `server`.
- `@open-bot/domain/server` is `packages/domain/src/server/index.ts`: signed tokens for VNC and the egress tunnel (`tokens.ts`), AES-256-GCM for secrets at rest (`secrets.ts`), and signed links to one page version (`page-links.ts`).

## Invariants

- Code in `packages/domain/src/server` imports `node:crypto`, so it is a separate entry and is never re-exported from `index.ts`.
- Lint enforces both directions: the isomorphic folders cannot import `node:*` or `server`, and `apps/mobile`, `packages/api` and web client code cannot import `@open-bot/domain/server`.
- Every set of values that crosses a package (a database column, an API field, a wire message) is defined once, here, as a value list, its schema and its type: `TASK_STATUSES`, `taskStatusSchema`, `TaskStatus`.
  The database types the column with `$type<TaskStatus>()` (and builds a `check()` from the list, like the memory tables), the API composes `taskStatusSchema`, and the apps import `TaskStatus`; nobody spells the values out again.
  A subset is derived (`Exclude`, `Extract`, or a list that `satisfies` the full type), never retyped.
- The egress enums are also the egress tunnel's wire values: `@open-bot/egress` writes them into its test vectors, and the phone's Kotlin `VectorsTest` checks them.
- Keep zod schemas for stored or exported data optional or defaulted, so old exports and old rows still parse (`packages/domain/src/teammates/bundle.ts`).

## Why account definitions live here

- `packages/domain/src/integrations/accounts`: definitions that both web and mobile can read (providers, scopes, tools, settings). It has no Node or database code.
- `packages/db` types its columns with unions derived from them, so they sit below `packages/db`.
- `packages/integrations` has the rest of each provider: sign-in, the token store, and the adapters that call Gmail, Calendar and Notion. It needs Node and the database.
- The worker refuses to start if adapters and definitions disagree (`specProblem` in `packages/integrations/src/integration-registry.ts`).
- The step-by-step recipe is "Add an account provider" in `packages/integrations/AGENTS.md`.

## Recipes

Paths are relative to the repo root; symbols are in parentheses.

### Add a field to a teammate

The field crosses every layer, from the database to web and mobile.

1. `packages/db/src/schema/teammates.ts` (`teammates`, with a default), then the migration recipe in `packages/db/AGENTS.md`.
2. `packages/domain/src/teammates/management.ts` (`teammateProfileSchema`, `teammateCreation()`), `packages/domain/src/teammates/bundle.ts` (optional or defaulted so old exports import).
3. `packages/api/src/views.ts` (`teammateSummarySchema`) if lists or mobile need it; `apps/web/src/features/teammates/server/queries.ts` (`listTeammates`).
4. Worker: `apps/worker/src/features/teammates/service.ts` (`list`, `get`, `exportBundle`, `addTeammate`, which duplicate and import share), `apps/worker/src/features/teammates/tools.ts` (`profileFields`), `apps/worker/src/features/teammates/changes.ts` (`PROFILE_LABELS`).
5. Web: `apps/web/src/features/teammates/components/bot-form.tsx` (`BotFormValues`), `apps/web/src/app/(app)/bots/new/page.tsx`, `apps/web/src/features/teammates/components/teammate-view.tsx`.
6. Mobile (display only; the contract has no teammate edit procedure): `apps/mobile/src/app/teammates/[botId].tsx`.
7. Ship web and worker together: the worker's schemas are strict and reject unknown keys.

### Add a realtime event (UI refresh after a change)

1. Add the type to `APP_EVENT_TYPES` in `packages/domain/src/events/app-events.ts`.
2. Say which procedures it refreshes in `APP_EVENT_REFRESHES` (`packages/api/src/events.ts`); it won't compile until you do.
   Web and mobile apply it as is.
3. Publish with `publishApp(ctx, { type })` in the worker or `publish({ type })` (`apps/web/src/lib/server/publish.ts`) in web.
4. Run timeline events are a different path: `RunEventWriter` or `appendRunEvent()`, reduced by `applyRunEvent` in `packages/domain/src/timeline/timeline.ts`.

## Tests

- `pnpm --filter @open-bot/domain test` runs the Vitest suites next to the code.
- `pnpm --filter @open-bot/domain typecheck` checks types.

## Docs

- `apps/site/src/app/docs/architecture/data/page.mdx`
- `apps/site/src/app/docs/flows/accounts/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
