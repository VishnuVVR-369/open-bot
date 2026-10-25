#!/usr/bin/env bash
set -euo pipefail
# This creates and removes only its own isolated container; it never connects to the normal app DB.
container="openbot-memory-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --name "$container" -e POSTGRES_PASSWORD=memory-test-only -e POSTGRES_DB=openbot_memory_test \
  --publish 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d openbot_memory_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
export MEMORY_TEST_DATABASE_URL="postgres://postgres:memory-test-only@127.0.0.1:${port}/openbot_memory_test"
pnpm --filter @open-bot/memory test
pnpm --filter @open-bot/worker build
node scripts/memory-worker-smoke.mjs
if [[ " ${*} " == *" --e2e "* ]]; then
  export DATABASE_URL="$MEMORY_TEST_DATABASE_URL"
  pnpm exec playwright test --config playwright.memory.config.ts
fi
