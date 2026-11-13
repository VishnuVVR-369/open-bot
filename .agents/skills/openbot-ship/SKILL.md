---
name: openbot-ship
description: Use before opening a PR, merging, deploying open-bot to Railway, or installing a phone build. Covers the checks that catch production-only failures and the deploy follow-through.
---

# Ship open-bot

The rules are in the root `AGENTS.md` ("Verification", "Workflow and scope").
This is the checklist for following them.

## Before the PR

- Run `pnpm verify:affected`, or `pnpm verify` when the change crosses many workspaces.
- Changed deps, bundling, or a workspace import? Build and start the real artifact: `node apps/worker/dist/worker.mjs`, `node apps/pages/dist/pages.mjs`. Missing bundled modules (`ERR_MODULE_NOT_FOUND`) only show up here.
- Start the worker artifact with `DATABASE_URL` and `BOTD_URL` set to throwaway targets (`scripts/test/pg.sh` gives a database). With neither set it uses the owner's development database and computer.
- Changed native Android code or config? Review [Android CI coverage](../../../apps/site/src/app/docs/development/page.mdx#android-ci), then run a release build or `./gradlew lintRelease` locally.

## Merge and deploy

- Only when asked. Squash merge.
- Retarget a stacked PR to `main` before merging it. Merged into its parent branch, its code never reaches `main`.
- The services are `web`, `worker`, `computer` and `pages`. `Postgres` only changes when migrations run.
- The worker's pre-deploy step runs DB migrations. If it fails, Railway stays on the old commit.
- Changed `.railway/`? The `Railway plan` workflow comments the plan on the PR; it must list only your changes. After the merge, follow the `Railway apply` workflow to success, then the deploys it causes. If apply fails, read `.railway/README.md`.
- For every affected service, confirm it runs the merged commit and check its startup logs (see `railway-cli-ssh`).

## Phone builds

- Release builds point at `https://openbot.up.railway.app`. A new API returns 404 there until it is deployed, so deploy before testing a phone build.
- Build steps are in `apps/mobile/README.md`. Install with `adb install -r` so the owner's app data is kept.
- Before saying "installed and up to date", confirm the build came from the commit you mean.
