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

| Folder                  | Owns                                                                          | Test                                     |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/web`              | Next.js app: UI, the oRPC API for browser and mobile, SSE                     | `pnpm --filter @open-bot/web test`       |
| `apps/worker`           | Runs teammates: run queue, tools, services, internal HTTP API, egress relay   | `pnpm --filter @open-bot/worker test`    |
| `apps/botd`             | Daemon inside the computer: screens, Chromium, VNC, Codex proxy, leases       | `pnpm --filter @open-bot/botd test`      |
| `apps/pages`            | Serves published pages on their own origin                                    | `pnpm --filter @open-bot/pages test`     |
| `apps/mobile`           | Expo Android app, native modules (egress, passkey, share intent, SMS consent) | `pnpm --filter @open-bot/mobile test`    |
| `apps/desktop`          | Electron Mac app: egress agent and notifications                              | typecheck only                           |
| `apps/site`             | Landing page and the technical docs (Cloudflare)                              | `pnpm --filter @open-bot/site test:e2e`  |
| `packages/domain`       | Isomorphic types, zod schemas and pure logic; Node-only helpers in `/server`  | `pnpm --filter @open-bot/domain test`    |
| `packages/api`          | oRPC contracts (web and mobile, worker internal, botd) and serializable views | `pnpm --filter @open-bot/api test`       |
| `packages/chat-core`    | Chat logic web and mobile share: turns, mentions, search, formatting          | `pnpm --filter @open-bot/chat-core test` |
| `packages/db`           | Drizzle schema, migrations, pool, NOTIFY channels and app events              | `pnpm test:integration`                  |
| `packages/integrations` | Google and Notion: sign-in, the token store, and the integrations' adapters   | `pnpm test:integration`                  |
| `packages/memory`       | Versioned memory and its background jobs                                      | `pnpm test:memory`                       |
| `packages/egress`       | Tunnel framing, mux, IP policy, SOCKS; vectors shared with Kotlin             | `pnpm --filter @open-bot/egress test`    |
| `packages/page-kit`     | Page CSS/JS, bundled libraries, page runtime and the `/page` skill            | `pnpm --filter @open-bot/page-kit test`  |
| `packages/agent`        | Codex app-server client; `src/protocol` is generated, never edit it           | `pnpm --filter @open-bot/agent test`     |
| `images/computer`       | The computer's Docker image and filesystem overlay                            | `pnpm computer:build`                    |
| `e2e`                   | Playwright specs for the whole stack, plus stand-ins for outside services     | `pnpm e2e`                               |
| `tools/showcase`        | Typed demo-data seed and screenshots for UI review                            | `pnpm --filter @open-bot/showcase seed`  |
| `scripts/test`          | Test runners (`pg.sh` starts a throwaway Postgres)                            | -                                        |
| `.railway`              | The Railway project as code: services, builds, watch paths                    | `pnpm test:railway`                      |

## Glossary

Use the canonical term in new code, UI copy and docs.
Older code still uses some legacy names; they are renamed in their own PRs, so don't add new uses and don't rename them in unrelated work.
`pnpm check:vocabulary` (run in CI) fails when a file gains a legacy name.
After removing uses or moving a file, run `pnpm check:vocabulary --update` and commit the baseline.
The header of `scripts/check/vocabulary.mjs` explains `--show <file>`, `--allow-growth` and the `vocabulary: allow` comment.

| Canonical term  | Meaning                                                                              | Do not use for it (legacy names in code)                                                       |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| teammate        | One AI agent the owner works with                                                    | bot (`bots` table, `botId`, `BotSummary`, `/bots/[botId]`)                                     |
| lead            | The teammate that answers group chats when nobody is mentioned                       | primary (only the database column `is_primary` is left)                                        |
| computer        | The botd container on Railway, with a persistent `/home` volume                      | -                                                                                              |
| browser         | Chromium run by botd inside the computer, never the owner's own browser              | -                                                                                              |
| screen          | A desktop session on the computer, one per teammate                                  | desktop                                                                                        |
| screen takeover | The owner controlling a screen; the teammate waits until it is handed back           | desktop takeover (only the database table `desktop_takeovers` is left)                         |
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

Each recipe lists the files to touch, in order.
It lives in the `AGENTS.md` of the workspace that owns the change, under "Recipes".

| To add                                  | Read                              |
| --------------------------------------- | --------------------------------- |
| an agent tool                           | `apps/worker/AGENTS.md`           |
| a worker internal route (called by web) | `apps/worker/AGENTS.md`           |
| a botd route (called by the worker)     | `apps/botd/AGENTS.md`             |
| a web screen                            | `apps/web/AGENTS.md`              |
| a mobile screen                         | `apps/mobile/AGENTS.md`           |
| a field on a teammate                   | `packages/domain/AGENTS.md`       |
| a realtime event (UI refresh)           | `packages/domain/AGENTS.md`       |
| a database table or column              | `packages/db/AGENTS.md`           |
| an account provider (OAuth)             | `packages/integrations/AGENTS.md` |
| a page-kit library                      | `packages/page-kit/AGENTS.md`     |

An environment variable has no single owner, so its recipe is here:

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
- `pnpm check:fast` runs formatting, lint and the four repository guards quietly, printing only failures. Use it during edits; `pnpm verify` and `pnpm verify:affected` include it, then types and tests. Integration tests start their own Postgres in Docker unless `TEST_DATABASE_URL` is set.
- Codex and Claude Code PostToolUse hooks format paths named by file-edit tools, respecting `.prettierignore` and `.gitignore`. Shell edits still need formatting before verification. Codex requires trusting repo hooks in `/hooks`; a harness that disables hooks still uses `pnpm check:fast`.
- Structure guardrails, each with a baseline that may only shrink: `pnpm check:file-size` (a new code file stays under 600 lines of code; aim for 400), `pnpm check:imports` (no new import cycle, no app importing another app's source) and the `open-bot/workspace-imports` lint rule (a package is imported through its name and `exports`).
  After shrinking a file, breaking a cycle or moving a baselined file, run the check with `--update` and commit the baseline.
  Details are under "Code structure" in `apps/site/src/app/docs/development/page.mdx`.
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
- `.ignore` keeps generated files (migration snapshots, the lockfile, the bundled viewer) out of ripgrep-based search. Pass `--no-ignore` to search them.

## Workflow and scope

- Keep implementation work to one PR or bounded phase per thread. For a multi-phase task, keep the parent for coordination and use a delegate with a separate checkout for each independent implementation; return the diff summary, checks and remaining work. Start a new thread only when the owner asks.
- Batch independent reads and searches in one tool turn. Find paths and symbols with `rg` first, then read the relevant code once; avoid repeated whole-file dumps. Keep large screenshot sets in the UI-review delegate and return a short summary.
- Run at most two delegates concurrently, including reviewers. On a rate limit, preserve partial results and wait for access rather than starting replacement delegates in parallel.
- The project Codex config compacts at 200,000 tokens. Other harnesses should compact around that point where supported; carry forward decisions, changed files, checks and pending work.
- On a PR wake that contains only informational bot comments and no changed checks, review decision or actionable request, end the turn without tool calls. A failed check, human request or review still needs action; a green check wake needs no repeated local checks.
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
