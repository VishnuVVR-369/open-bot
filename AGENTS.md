<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# open-bot

Personal AI teammates: each teammate is a Codex agent that works on a shared Linux computer, chats with the owner, and asks before risky actions.
This file is the map.
Each workspace has its own `AGENTS.md` with details, and the technical docs live in `apps/site/src/app/docs/` (see "Architecture docs" below).

## Repo map

Workspace packages are consumed as TypeScript source (`exports` point at `src/*.ts`).
A new workspace dependency must also be added to the consumer's bundler config: `apps/worker/build.mjs`, `transpilePackages` in `apps/web/next.config.ts`, and the esbuild calls of botd and pages.
For a deployed service it must also be added to that service's list in `.railway/watch-paths.ts`, or changes to it never redeploy the service (`pnpm test:railway` catches a missing folder).

| Folder                  | Owns                                                                          | Entry                                 | Test                                     |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| `apps/web`              | Next.js app: UI, the oRPC API for browser and mobile, SSE                     | `apps/web/src/app`                    | `pnpm --filter @open-bot/web test`       |
| `apps/worker`           | Runs teammates: run queue, tools, services, internal HTTP API, egress relay   | `apps/worker/src/index.ts`            | `pnpm --filter @open-bot/worker test`    |
| `apps/botd`             | Daemon inside the computer: screens, Chromium, VNC, Codex proxy, leases       | `apps/botd/src/index.ts`              | `pnpm --filter @open-bot/botd test`      |
| `apps/pages`            | Serves published pages on their own origin                                    | `apps/pages/src/index.ts`             | `pnpm --filter @open-bot/pages test`     |
| `apps/mobile`           | Expo Android app, native modules (egress, passkey, share intent, SMS consent) | `apps/mobile/src/app`                 | `pnpm --filter @open-bot/mobile test`    |
| `apps/desktop`          | Electron Mac app: egress agent and notifications                              | `apps/desktop/src/main.ts`            | typecheck only                           |
| `apps/site`             | Landing page and the technical docs (Cloudflare)                              | `apps/site/src/app`                   | `pnpm --filter @open-bot/site test:e2e`  |
| `packages/domain`       | Isomorphic types, zod schemas and pure logic; Node-only helpers in `/server`  | `packages/domain/src/index.ts`        | `pnpm --filter @open-bot/domain test`    |
| `packages/api`          | oRPC contracts (web and mobile, worker internal, botd) and serializable views | `packages/api/src/contract.ts`        | `pnpm --filter @open-bot/api test`       |
| `packages/chat-core`    | Chat logic web and mobile share: turns, mentions, search, formatting          | `packages/chat-core/src/index.ts`     | `pnpm --filter @open-bot/chat-core test` |
| `packages/db`           | Drizzle schema, migrations, pool, NOTIFY channels and app events              | `packages/db/src/schema/index.ts`     | `pnpm test:integration`                  |
| `packages/integrations` | Google and Notion: sign-in, the token store, and the integrations' adapters   | `packages/integrations/src/server.ts` | `pnpm test:integration`                  |
| `packages/memory`       | Versioned memory and its background jobs                                      | `packages/memory/src/index.ts`        | `pnpm test:memory`                       |
| `packages/egress`       | Tunnel framing, mux, IP policy, SOCKS; vectors shared with Kotlin             | `packages/egress/src/index.ts`        | `pnpm --filter @open-bot/egress test`    |
| `packages/page-kit`     | Page CSS/JS, bundled libraries, page runtime and the `/page` skill            | `packages/page-kit/src/index.ts`      | `pnpm --filter @open-bot/page-kit test`  |
| `packages/agent`        | Codex app-server client; `src/protocol` is generated, never edit it           | `packages/agent/src/client.ts`        | `pnpm --filter @open-bot/agent test`     |
| `images/computer`       | The computer's Docker image and filesystem overlay                            | `images/computer/Dockerfile`          | `pnpm computer:build`                    |
| `e2e`                   | Playwright specs for the whole stack, plus stand-ins for outside services     | `playwright.config.ts`                | `pnpm e2e`                               |
| `tools/showcase`        | Typed demo-data seed and screenshots for UI review                            | `tools/showcase/seed.ts`              | `pnpm --filter @open-bot/showcase seed`  |
| `scripts/test`          | Test runners (`pg.sh` starts a throwaway Postgres)                            | `scripts/test/integration.sh`         | -                                        |
| `.railway`              | The Railway project as code: services, builds, watch paths                    | `.railway/railway.ts`                 | `pnpm test:railway`                      |

## Glossary

Use the canonical term in new code, UI copy and docs.
Older code still uses some banned synonyms; those get renamed later, so don't add new uses and don't rename them in unrelated work.
`pnpm check:vocabulary` (`scripts/check/vocabulary.mjs`, run in CI) fails when a file gains a use of a legacy name: it counts them per file against `scripts/check/vocabulary-baseline.json`, which may only shrink.
After removing uses or moving a file, run `pnpm check:vocabulary --update` and commit the new baseline.
`--update` refuses to raise any term's total; `--allow-growth` is only for a reviewed change, such as a stricter rule.
`pnpm check:vocabulary --show <file>` lists a file's uses.
A line that must keep a legacy word, such as a third-party API name, can end with a `vocabulary: allow` comment.

| Canonical term  | Meaning                                                                              | Do not use for it (legacy names in code)                                                       |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| teammate        | One AI agent the owner works with                                                    | bot (`bots` table, `botId`, `BotSummary`, `/bots/[botId]`)                                     |
| lead            | The teammate that answers group chats when nobody is mentioned                       | primary (`isPrimary`, `is_primary`, `setPrimaryBot`)                                           |
| computer        | The botd container on Railway, with a persistent `/home` volume                      | -                                                                                              |
| browser         | Chromium run by botd inside the computer, never the owner's own browser              | -                                                                                              |
| screen          | A desktop session on the computer, one per teammate                                  | desktop                                                                                        |
| screen takeover | The owner controlling a screen; the teammate waits until it is handed back           | desktop takeover (`desktopTakeovers`, `desktop_takeovers`)                                     |
| lease           | Who holds a screen's input right now (teammate, owner or nobody)                     | -                                                                                              |
| desktop app     | The Electron app in `apps/desktop`; "desktop" means only this                        | -                                                                                              |
| integration     | Umbrella for anything a teammate uses outside the computer: connections and accounts | -                                                                                              |
| connection      | An MCP server integration                                                            | -                                                                                              |
| account         | An OAuth integration (Google, Notion)                                                | `accounts` table, planned `account_connections`; Better Auth's `account` is sign-in, unrelated |
| automation      | Umbrella for schedules, page watches, webhooks and account triggers                  | schedule or trigger as the umbrella (`/schedules` only redirects)                              |
| page            | An HTML page a teammate publishes, served by `apps/pages`                            | -                                                                                              |
| run / turn      | One queued unit of teammate work / one Codex turn inside it                          | -                                                                                              |
| stand-in        | A test double for an outside service                                                 | mock, fake, fixture                                                                            |

The guard checks code files for bot, primary (meaning the lead), desktop takeover, and `e2e/` files named mock or fake; the other terms are kept by review.
The owner has approved the renames, which happen after feature slicing so files move once: `bots` and `bot_id` to teammates, `is_primary` to lead, `desktop_takeovers` to `screen_takeovers`, and the integrations `accounts` table to `account_connections`.
Database renames use `ALTER TABLE ... RENAME` migrations with a plan for the window between migration and deploy, and renamed web routes keep redirects for bookmarks and phone deep links.

## Where to make common changes

These list today's files in order.
Paths are relative to the repo root; symbols are in parentheses.

**Add an agent tool** (non-account)

1. One `defineTool({ name, description, input, helpers, handle })` in the feature's file in `apps/worker/src/tools/` (`pages.ts`, `automations.ts`, ...): `input` is a zod object, Codex is offered its JSON schema, and calls are parsed with it before `handle` runs, so the handler gets typed `call.args` (`call.raw` is what Codex sent, for the timeline item); `helpers: "forbidden"` keeps swarm helpers from calling it; `handle` records a timeline item with `session.putItem(toolItem(...))` and calls `publishApp` if the UI shows the change. A new feature's file adds its list to `TOOLS` in `apps/worker/src/tools/definitions.ts`.
2. Bump `TOOLS_VERSION` in `apps/worker/src/tools/definitions.ts`. Without the bump, existing threads never see the tool. Then `pnpm --filter @open-bot/worker test -u` updates the tool list snapshot (`apps/worker/src/tools/__snapshots__/tools.json`); review its diff.
3. A new service goes in `ToolServices` (`apps/worker/src/tools/define.ts`), passed by name in `apps/worker/src/index.ts`.
4. Optional: rules in `DEVELOPER_INSTRUCTIONS` (`apps/worker/src/instructions.ts`, bump `TOOLS_VERSION` again), an icon, or `asksApproval` for a tool whose call is itself the approval request, in `TOOL_DISPLAY` (`packages/domain/src/timeline/tool-display.ts`), which web and mobile both read. A new icon meaning needs its icon in `apps/web/src/components/chat/items.tsx` and `apps/mobile/src/components/chat/tool-icons.ts`.
5. Document it in `apps/site/src/app/docs/reference/tools/page.mdx`.

**Add a worker internal route** (called by web)

1. `packages/api/src/worker/contract.ts`: add a procedure to `workerContract` with its `route` (`/internal/...`), input and output schemas. Use `computer` instead of `base` if it touches the computer, or it will not wake it; never for a status read.
2. `apps/worker/src/rpc/router.ts`: implement it by calling a service. Put rules in the service, and throw the service's own error class; `apps/worker/src/rpc/errors.ts` maps error classes to statuses in one place. Auth (`x-worker-secret`) is automatic.
3. Call it from web with the typed client: `worker.<domain>.<procedure>(input)` (`apps/web/src/lib/server/worker.ts`) in `apps/web/src/lib/server/api/*`. Failures are `WorkerError` with the worker's status and message.
4. Document it in `apps/site/src/app/docs/reference/http-api/page.mdx`.

**Add a botd route** (called by the worker)

1. Shapes botd sends or takes go in `packages/domain/src/computer/protocol.ts` as zod schemas.
2. `packages/api/src/botd/contract.ts`: add a procedure to `botdContract` with its `route`, input and output. Build it with `work` if it touches the computer, or it will not wake it and botd will not count it as activity; never for a status read.
3. `apps/botd/src/router.ts`: implement it. Throw `ORPCError` with a status for a refusal; `apps/botd/src/rpc.ts` maps every other error in one place.
4. `apps/worker/src/computer.ts`: call it with `this.botd.<domain>.<procedure>(input)` behind a `ComputerClient` method. The answer is already validated; failures are `BotdError` with botd's status.
5. The computer and the worker deploy separately: keep old paths and input fields until no deployed worker sends them. Test it in `apps/botd/src/contract.test.ts` and document it in `apps/site/src/app/docs/reference/http-api/page.mdx`.

**Add a field to a teammate** (web and mobile)

1. `packages/db/src/schema/teammates.ts` (`bots`, with a default), then the migration recipe below.
2. `packages/domain/src/teammates/management.ts` (`botProfileSchema`, `botCreation()`), `packages/domain/src/teammates/bundle.ts` (optional or defaulted so old exports import).
3. `packages/api/src/views.ts` (`botSummarySchema`) if lists or mobile need it; `apps/web/src/lib/server/queries.ts` (`listBots`).
4. Worker: `apps/worker/src/services/bots.ts` (`list`, `get`, `exportBundle`, `addTeammate`, which duplicate and import share), `apps/worker/src/tools/teammates.ts` (`profileFields`), `apps/worker/src/tools/bots.ts` (`PROFILE_LABELS`).
5. Web: `apps/web/src/components/bots/bot-form.tsx` (`BotFormValues`), `apps/web/src/app/(app)/bots/new/page.tsx`, `apps/web/src/app/(app)/bots/[botId]/page.tsx`.
6. Mobile (display only; the contract has no teammate edit procedure): `apps/mobile/src/app/teammates/[botId].tsx`.
7. Ship web and worker together: the worker's schemas are strict and reject unknown keys.

**Add a database table or column**

1. Edit the area's file in `packages/db/src/schema/` (a new area gets a file, exported from `index.ts`). Keep changes additive (nullable or defaulted): the old web and worker keep running until the deploy finishes.
   A new table gets its owner, the one module that writes it, in `packages/db/src/owners.ts`; the `open-bot/table-owners` lint rule refuses writes anywhere else.
2. `pnpm db:generate --name <snake_name>` writes `packages/db/drizzle/<NNNN>_<name>.sql` plus the `meta/` snapshot and journal. Commit all three.
3. Read the SQL. Add backfills by hand before it ships, separated by `--> statement-breakpoint`. Never edit a migration that has shipped.
4. `pnpm db:migrate` locally, `pnpm test:integration`. On Railway the worker's pre-deploy step runs migrations; if one fails, Railway stays on the old commit.

**Add an account provider** (OAuth)

1. `packages/domain/src/integrations/accounts/<provider>.ts`: provider and integration definitions; register them in `packages/domain/src/integrations/accounts/registry.ts`.
2. `packages/integrations/src/providers/<provider>/oauth.ts` (a `ProviderAdapter`), registered in `providerAdapters()` (`packages/integrations/src/provider-registry.ts`); its endpoints in `integrationEndpoints()` (`packages/integrations/src/core/endpoints.ts`), with the override read in `apps/worker/src/env.ts` and `apps/web/src/lib/server/env.ts`.
3. `packages/integrations/src/providers/<provider>/<integration>/adapter.ts` (an `IntegrationAdapter`), added to `ADAPTERS` in `packages/integrations/src/integration-registry.ts`. The worker refuses to start if adapters and definitions disagree. Bump `TOOLS_VERSION`.
4. Web: `CLIENT_GUIDES` in `apps/web/src/components/settings/provider-guides.tsx` for owner-supplied OAuth clients; icons in `accounts-section.tsx` and `items.tsx` if new.
5. A stand-in in `e2e/stand-ins/` (one file per service, served by `AccountsStandIn` in `e2e/stand-ins/accounts.ts`), and docs in `apps/site/src/app/docs/flows/accounts/page.mdx`.

**Add a page-kit library**

1. `packages/page-kit/package.json` (exact version), `packages/page-kit/scripts/build.mjs` (`files`), `packages/page-kit/src/index.ts` (`PAGE_LIBRARIES`; the `/page` skill lists it automatically).
2. Optional theming in `packages/page-kit/src/kit/kit.js` and `page.css`. `packages/page-kit/src/kit.test.ts` checks every `/lib` path.
3. The computer image bundles page-kit too, so the computer must redeploy. Pages have no "type"; libraries are the extension point.

**Add a web screen**

1. `apps/web/src/app/(app)/<route>/page.tsx` (thin, wraps `<Page>`), importing its view from the feature's `index.ts`.
   A feature is a folder in `apps/web/src/features/<feature>/` (`apps/web/src/features/tasks` is the example): `"use client"` views in `components/`, hooks in `hooks.ts`, and the server side in `server/`, reached through `server.ts`.
   Areas not moved yet still live in `apps/web/src/components/<area>/`, `apps/web/src/lib/server/queries.ts` and `apps/web/src/lib/client/queries.ts`.
2. A procedure in `packages/api/src/contract.ts` with its view schema; its read in the feature's `server/queries.ts` and its handlers in `server/routes.ts` (built with `os` from `apps/web/src/lib/server/api/rpc.ts`), mounted in `apps/web/src/lib/server/api/router.ts`; and a hook in the feature's `hooks.ts` (`orpc.<path>.queryOptions()`).
   Say which app events refresh it in `APP_EVENT_REFRESHES` (`packages/api/src/events.ts`).
3. Nav: `apps/web/src/components/app/sidebar.tsx` and `apps/web/src/components/app/command-menu.tsx`.

**Add a mobile screen**

1. A file in `apps/mobile/src/app/` plus its `Tabs.Screen` in `(tabs)/_layout.tsx` or `Stack.Screen` in `_layout.tsx`.
2. Data: a view in `packages/api/src/views.ts`, a procedure in `packages/api/src/contract.ts`, its handler in `apps/web/src/lib/server/api/router.ts`, a hook in `apps/mobile/src/lib/queries.ts` and a key in `apps/mobile/src/lib/query.ts` (`keysForAppEvent`).
3. Search entry in `apps/mobile/src/app/search.tsx` (`PAGES`); notification links in `apps/mobile/src/lib/links.ts` and the worker's `nativeUrl()` in `apps/worker/src/services/fcm.ts`.

**Add a realtime event** (UI refresh after a change)

1. Add the type to `APP_EVENT_TYPES` in `packages/domain/src/events/app-events.ts`.
2. Say which procedures it refreshes in `APP_EVENT_REFRESHES` (`packages/api/src/events.ts`); it won't compile until you do.
   The web app applies it as is.
3. Publish with `publishApp(ctx, { type })` in the worker or `publish({ type })` (`apps/web/src/lib/server/publish.ts`) in web.
4. Mobile still has its own keys: add the type to `keysForAppEvent` in `apps/mobile/src/lib/query.ts`.
5. Run timeline events are a different path: `RunEventWriter` or `appendRunEvent()`, reduced by `applyRunEvent` in `packages/domain/src/timeline/timeline.ts`.

**Add an environment variable**

1. Read it only in the app's env module, listed in `scripts/lint/env-modules.mjs` (for example `apps/worker/src/env.ts`, `apps/web/src/lib/server/env.ts`); ESLint refuses `process.env` anywhere else in apps and packages.
   A package never reads it: take the value as an argument or config object from the app.
2. A secret with a development default goes in `DEV_SECRETS` (`packages/domain/src/server/secrets.ts`), so production refuses to start with it.
3. Document it in `apps/site/src/app/docs/reference/configuration/page.mdx`, and in `.env.example` with a comment if the web app, the worker or the pages service reads it.
   `pnpm test:scripts` (`scripts/check/env.test.mjs`) fails when either is missing.

## Verification

- Pick checks by the boundary you changed. If you touched deps, bundling, or native config, run the built artifact, not just source tests.
- A new test must fail without the fix. Bypass the turbo cache (`--force`) when results must prove something. Use `set -o pipefail`.
- Treat a flaky test as a possible real race first. Sync on observable events, never sleeps or reruns.
- Every PR check must pass, including Cloudflare. Treat any red check as a real failure.
- Skip tests that need >10 min of waiting or physical user action. List them as untested. Batch any phone action into one ask.
- `pnpm verify` runs lint, the doc path, vocabulary, file size and import checks, typecheck, unit, script and integration tests; integration tests start their own Postgres in Docker unless `TEST_DATABASE_URL` is set.
- Structure guardrails, each with a baseline that may only shrink (details under "Code structure" in `apps/site/src/app/docs/development/page.mdx`):
  `pnpm check:file-size` fails on a new code file over 600 lines of code (blank lines and comments not counted; aim for 400) and on a baselined file that grows, so split the file.
  `pnpm check:imports` fails on an import that closes a new cycle (`import type` counts) and on an app importing another app's source.
  The `open-bot/workspace-imports` lint rule makes every import of a package go through its name and `exports`.
  After shrinking a file, breaking a cycle or moving a baselined file, run the check with `--update` and commit the baseline; `--update` refuses growth.
- The full list of suites and what each needs is in `apps/site/src/app/docs/development/page.mdx`; every environment variable is in `apps/site/src/app/docs/reference/configuration/page.mdx`.

| Changed path                               | Run                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| any TS                                     | `pnpm verify:affected`                                                                               |
| `packages/db/src/schema/**`                | `pnpm db:generate`, review the SQL, `pnpm test:integration`                                          |
| `packages/egress/**`                       | `pnpm --filter @open-bot/egress vectors`, then `./gradlew test` in `apps/mobile/modules/egress/core` |
| `apps/worker/**` deps or bundling          | `pnpm --filter @open-bot/worker build && node apps/worker/dist/worker.mjs`                           |
| `apps/pages/**`, `packages/page-kit/**`    | `pnpm --filter @open-bot/pages build && node apps/pages/dist/pages.mjs`                              |
| `apps/mobile/**` native or `app.config.ts` | prebuild and release lint (openbot-mobile skill)                                                     |
| `apps/botd/**`, `images/computer/**`       | openbot-computer skill checklist, `pnpm computer:build`                                              |
| `apps/site/**`                             | `pnpm --filter @open-bot/site typecheck`, `pnpm --filter @open-bot/site test:e2e`                    |
| any `*.md` or `*.mdx`                      | `pnpm check:doc-paths`                                                                               |
| `.railway/**`                              | `pnpm test:railway`; the PR's `Railway plan` comment must list only your changes                     |
| UI anywhere                                | openbot-ui-review skill                                                                              |

## Architecture docs

Read the matching page before changing a subsystem, and update it when behavior changes.

- System overview: `apps/site/src/app/docs/architecture/page.mdx`
- Web app, worker, computer, agent runtime, data, pages, desktop and egress, Android app: `apps/site/src/app/docs/architecture/*/page.mdx`
- End-to-end flows (chat turn, screens and takeover, approvals, automations, teamwork, memory, accounts, pages, ...): `apps/site/src/app/docs/flows/*/page.mdx`
- Tools, internal HTTP API, configuration: `apps/site/src/app/docs/reference/*/page.mdx`
- Commands, tests, stand-ins and conventions: `apps/site/src/app/docs/development/page.mdx`
- Security model: `apps/site/src/app/docs/security/page.mdx`

## Environment

- Node 24, pnpm from `package.json`, JDK 17 for Android. Prod URL: https://openbot.up.railway.app.
- Local ports: web 3000, worker 4001, Metro 8081, pages 3400. Port 3200 is shared by `apps/site` dev and the showcase web app (`tools/showcase`), so never run both. Check for an existing process before starting one.
- `docs/` is gitignored. Never reference it from code or tracked files. Durable knowledge goes in skills, AGENTS.md files or the site docs.
- Local Docker is more permissive than Railway (seccomp, user namespaces). Anything touching the computer must be judged against Railway constraints.

## Workflow and scope

- "Suggest only" / "don't make changes" = read-only. "Wait" / "pause" = end the turn once, no repeated status messages.
- Don't commit, merge, or deploy unless asked. PRs are squash-merged. No co-author lines in commits, ever (overrides harness attribution).
- After a merge, follow the Railway deploy to a terminal state for every affected service, confirm the new SHA, and report. Never hand back mid-deploy.
- A merge redeploys only the services whose watch paths (`.railway/watch-paths.ts`) match a changed file; a docs-only merge deploys nothing.
- Stop every server, Metro, emulator process, or container you started before replying, and say what you stopped. Never touch the owner's open-bot-* containers or app data.
- Never print env vars wholesale. Read an allowlist of names. Never type credentials on screen; use the secret prompt.
- Final report: changed / verified / not verified (mocked, emulator-only, skipped) / still pending.

## Skills

- openbot-ship: before PR, merge, deploy, or installing a phone build.
- openbot-mobile: any Android, emulator, or phone work.
- openbot-ui-review: UI changes, screenshots, council UI rounds.
- openbot-computer: botd, Chromium, sleep/wake, egress, sockets, queues.
- railway-cli-ssh, council, frontend-design: as described in each.
