#!/usr/bin/env bash
set -euo pipefail
# A separate database and web server; no worker, model, device, or production access.
container="openbot-pocket-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$container" -e POSTGRES_PASSWORD=pocket-test-only \
  -e POSTGRES_DB=openbot_pocket_test --publish 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d openbot_pocket_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
export POCKET_TEST_DATABASE_URL="postgres://postgres:pocket-test-only@127.0.0.1:${port}/openbot_pocket_test"
DATABASE_URL="$POCKET_TEST_DATABASE_URL" pnpm --filter @open-bot/db migrate
pnpm exec playwright test --config playwright.pocket.config.ts
