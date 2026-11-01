#!/usr/bin/env bash
set -euo pipefail
# Only this disposable database is used. The normal app database is never contacted.
container="openbot-bot-management-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$container" -e POSTGRES_PASSWORD=bots-test-only \
  -e POSTGRES_DB=openbot_bot_management_test --publish 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$container" pg_isready -U postgres -d openbot_bot_management_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
export BOT_MANAGEMENT_TEST_DATABASE_URL="postgres://postgres:bots-test-only@127.0.0.1:${port}/openbot_bot_management_test"
pnpm --filter @open-bot/worker exec vitest run src/tools/bots.integration.test.ts
