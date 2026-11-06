#!/usr/bin/env bash
set -euo pipefail
# Only this disposable database is used. The normal app database is never contacted.
container="openbot-mobile-api-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$container" -e POSTGRES_PASSWORD=mobile-api-test-only \
  -e POSTGRES_DB=openbot_mobile_api_test --publish 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$container" pg_isready -U postgres -d openbot_mobile_api_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
export MOBILE_API_TEST_DATABASE_URL="postgres://postgres:mobile-api-test-only@127.0.0.1:${port}/openbot_mobile_api_test"
pnpm --filter @open-bot/worker exec vitest run --no-file-parallelism src/runs/dispatch.integration.test.ts src/services/fcm.integration.test.ts src/uploads.integration.test.ts src/services/screen-operations.integration.test.ts src/services/pages.integration.test.ts src/accounts/actions.integration.test.ts src/services/account-triggers.integration.test.ts
pnpm --filter @open-bot/web exec vitest run src/lib/server/egress-device.integration.test.ts
