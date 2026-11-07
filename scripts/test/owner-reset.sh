#!/usr/bin/env bash
# The owner password reset (scripts/ops/owner-reset-password.mjs), end to end. Needs Docker;
# starts its own throwaway Postgres. The normal app database is never contacted.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [[ "${TEST_DATABASE_URL:-}" != */openbot_owner_reset_test ]]; then
  TEST_PG_DATABASE=openbot_owner_reset_test exec bash scripts/test/pg.sh bash scripts/test/owner-reset.sh "$@"
fi
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @open-bot/db migrate >/dev/null
OWNER_RESET_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test scripts/ops/owner-reset-password.test.mjs
