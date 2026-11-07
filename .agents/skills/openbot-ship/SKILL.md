---
name: openbot-ship
description: Use before opening a PR, merging, deploying open-bot to Railway, or installing a phone build. Covers the checks that catch production-only failures and the deploy follow-through.
---

# Ship open-bot

## Before the PR

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`. Add `--force` to turbo runs when the result must prove something; cache hits prove nothing.
- Run commands with `set -o pipefail` so a pipe never hides a failure.
- Changed deps, bundling, or a workspace import? Build and start the real artifact: `node apps/worker/dist/worker.mjs`, `node apps/pages/dist/pages.mjs`. Missing bundled modules (`ERR_MODULE_NOT_FOUND`) only show up here.
- Changed native Android code or config? CI builds debug only. Run a release build or `./gradlew lintRelease` locally.
- Every PR check must pass, including Cloudflare. Treat any red check as a real failure.

## Merge and deploy

- Only when asked. Squash merge.
- Merging to `main` auto-deploys Railway services `web`, `worker`, `computer`, `pages` (plus `Postgres`, which only changes when migrations run).
- The worker's pre-deploy step runs DB migrations. If it fails, Railway stays on the old commit.
- Wait for every affected service to reach a final state, confirm it runs the merged commit, and check startup logs (see `railway-cli-ssh`). Report the result. Never hand back mid-deploy.

## Phone builds

- Release builds point at `https://openbot.up.railway.app`. A new API returns 404 there until it is deployed, so deploy before testing a phone build.
- Build steps are in `apps/mobile/README.md`. Install with `adb install -r` so the owner's app data is kept.
- Before saying "installed and up to date", confirm the build came from the commit you mean.
