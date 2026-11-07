<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# open-bot

## Glossary

- "Computer" = the botd container (apps/botd) on Railway, with a persistent /home volume.
- "Browser" = Chromium run by botd inside the computer, never the user's Mac browser.
- "Screen" = a desktop session on the computer. "Teammate" = a bot.
- Apps: web (Next.js), worker, botd, pages (separate origin), site (Cloudflare docs/landing), mobile (Expo Android), desktop.
- Shared contracts live in packages/api; integrations in packages/shared/src/accounts + packages/accounts. Reuse them; don't add parallel abstractions.

## Environment

- Node 24, pnpm from package.json, JDK 17 for Android. Prod URL: https://openbot.up.railway.app.
- Local ports: web 3000, worker 4001, Metro 8081, pages 3400. Port 3200 is shared by apps/site dev and the showcase web app (scripts/showcase), so never run both. Check for an existing process before starting one.
- docs/ is gitignored. Never reference it from code or tracked files. Durable knowledge goes in skills or tracked READMEs.
- Local docker is more permissive than Railway (seccomp, user namespaces). Anything touching the computer must be judged against Railway constraints.

## Verification

- Pick checks by the boundary you changed. If you touched deps, bundling, or native config, run the built artifact (node dist/worker.mjs, pages build, Android release lint), not just source tests.
- A new test must fail without the fix. Bypass turbo cache (--force) when results must prove something. Use `set -o pipefail`.
- Treat a flaky test as a possible real race first. Sync on observable events, never sleeps or reruns.
- The Cloudflare Workers/Pages GitHub check is known-red. Ignore it unless asked. CI gate = lint, typecheck, tests.
- Skip tests that need >10 min of waiting or physical user action. List them as untested. Batch any phone action into one ask.

## Workflow and scope

- "Suggest only" / "don't make changes" = read-only. "Wait" / "pause" = end the turn once, no repeated status messages.
- Don't commit, merge, or deploy unless asked. PRs are squash-merged. No co-author lines in commits, ever (overrides harness attribution).
- After a merge, follow the Railway deploy to a terminal state for every affected service, confirm the new SHA, and report. Never hand back mid-deploy.
- Stop every server, Metro, emulator process, or container you started before replying, and say what you stopped. Never touch the owner's open-bot-* containers or app data.
- Never print env vars wholesale. Read an allowlist of names. Never type credentials on screen; use the secret prompt.
- Final report: changed / verified / not verified (mocked, emulator-only, skipped) / still pending.

## Skills

- openbot-ship: before PR, merge, deploy, or installing a phone build.
- openbot-mobile: any Android, emulator, or phone work.
- openbot-ui-review: UI changes, screenshots, council UI rounds.
- openbot-computer: botd, Chromium, sleep/wake, egress, sockets, queues.
- railway-cli-ssh, council, frontend-design: as described in each.
