#!/usr/bin/env bash
# The pocket inbox Playwright spec: a separate database and web server; no worker, model, device,
# or production access. Needs Docker and Playwright's Chromium; starts its own throwaway Postgres.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [[ "${TEST_DATABASE_URL:-}" != */openbot_pocket_test ]]; then
  TEST_PG_DATABASE=openbot_pocket_test exec bash scripts/test/pg.sh bash scripts/test/pocket-inbox.sh "$@"
fi
export POCKET_TEST_DATABASE_URL="$TEST_DATABASE_URL"
DATABASE_URL="$POCKET_TEST_DATABASE_URL" pnpm --filter @open-bot/db migrate
pnpm exec playwright test --config playwright.pocket.config.ts
