#!/usr/bin/env bash
# Memory: the memory integration suite, then the built worker's memory smoke test, and with
# `--e2e` the memory Playwright spec. Needs Docker; starts its own throwaway Postgres.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [[ "${TEST_DATABASE_URL:-}" != */openbot_memory_test ]]; then
  TEST_PG_DATABASE=openbot_memory_test exec bash scripts/test/pg.sh bash scripts/test/memory.sh "$@"
fi
export MEMORY_TEST_DATABASE_URL="$TEST_DATABASE_URL"
pnpm --filter @open-bot/memory test:integration
DATABASE_URL="$MEMORY_TEST_DATABASE_URL" pnpm --filter @open-bot/db migrate
pnpm --filter @open-bot/worker build
node scripts/dev/memory-worker-smoke.mjs
if [[ " ${*:-} " == *" --e2e "* ]]; then
  export DATABASE_URL="$MEMORY_TEST_DATABASE_URL"
  pnpm exec playwright test --config playwright.memory.config.ts
fi
