#!/usr/bin/env bash
set -euo pipefail
# The owner password reset, end to end against a disposable Postgres. The normal app database is
# never contacted.
container="openbot-owner-reset-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$container" -e POSTGRES_PASSWORD=reset-test-only \
  -e POSTGRES_DB=openbot_owner_reset_test --publish 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$container" pg_isready -U postgres -d openbot_owner_reset_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
url="postgres://postgres:reset-test-only@127.0.0.1:${port}/openbot_owner_reset_test"
DATABASE_URL="$url" pnpm --filter @open-bot/db migrate >/dev/null
OWNER_RESET_TEST_DATABASE_URL="$url" node --test scripts/owner-reset-password.test.mjs
