#!/usr/bin/env bash
set -euo pipefail
# Only this disposable database is used. The normal app database is never contacted.
container="openbot-accounts-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$container" -e POSTGRES_PASSWORD=accounts-test-only \
  -e POSTGRES_DB=openbot_accounts_test --publish 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$container" pg_isready -U postgres -d openbot_accounts_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
export ACCOUNTS_TEST_DATABASE_URL="postgres://postgres:accounts-test-only@127.0.0.1:${port}/openbot_accounts_test"
pnpm --filter @open-bot/accounts exec vitest run src/store.integration.test.ts
