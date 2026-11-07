#!/usr/bin/env bash
# Computer sleep and wake, end to end: a real computer container, Postgres and the built worker.
# Needs Docker and the computer image (pnpm computer:build). Independent containers and storage
# only; never touches the normal compose project or Railway.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
computer="openbot-sleep-test-computer-$$"
database="openbot-sleep-test-db-$$"
volume="openbot-sleep-test-home-$$"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  docker rm -fv "$computer" "$database" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
pnpm --filter @open-bot/botd build
pnpm --filter @open-bot/worker build
image="${COMPUTER_TEST_IMAGE:-open-bot-computer:dev}"
docker image inspect "$image" >/dev/null || { echo "Build the computer test image first: docker build -t $image -f images/computer/Dockerfile ." >&2; exit 1; }
docker volume create "$volume" >/dev/null
docker run -d --name "$computer" -e BOTD_TOKEN=sleep-test-only-token-20261107 \
  -e COMPUTER_LIFECYCLE_ENABLED=true -e MAX_SCREENS=2 -p 127.0.0.1::7000 \
  --shm-size=2g --security-opt seccomp=unconfined --mount "source=$volume,target=/home" \
  --mount "type=bind,source=$root/apps/botd/dist/botd.mjs,target=/opt/botd/botd.mjs,readonly" "$image" >/dev/null
docker run -d --name "$database" -e POSTGRES_PASSWORD=sleep-test-only \
  -e POSTGRES_DB=openbot_sleep_test -p 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$database" pg_isready -U postgres -d openbot_sleep_test >/dev/null 2>&1; then break; fi
  sleep 1
done
db_port="$(docker port "$database" 5432/tcp | head -1 | sed 's/.*://')"
computer_port="$(docker port "$computer" 7000/tcp | head -1 | sed 's/.*://')"
export DATABASE_URL="postgres://postgres:sleep-test-only@127.0.0.1:$db_port/openbot_sleep_test"
export BOTD_URL="http://127.0.0.1:$computer_port"
for ((i=0;i<60;i++)); do
  if curl -fsS "$BOTD_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
pnpm --filter @open-bot/db migrate
docker exec "$database" psql -U postgres -d openbot_sleep_test -c "insert into settings (id,chatgpt_auth_source) values (1,'device');" >/dev/null
# Disposable fake credential permits filesystem RPCs; no real account or model generation.
docker exec "$computer" sh -c 'printf %s "{\"OPENAI_API_KEY\":\"sk-lifecycle-test-only-not-a-real-key\"}" > /home/bot/.codex/auth.json && chown bot:bot /home/bot/.codex/auth.json && chmod 600 /home/bot/.codex/auth.json'
export WORKER_PORT="${SLEEP_TEST_WORKER_PORT:-14092}"
export SLEEP_TEST_FIXTURE_PORT="${SLEEP_TEST_FIXTURE_PORT:-14799}"
COMPUTER_LIFECYCLE_ENABLED=true COMPUTER_IDLE_MINUTES=0.03 OPEN_BOT_PLAN_BASE_URL="http://host.docker.internal:$SLEEP_TEST_FIXTURE_PORT/model" \
  BOTD_TOKEN=sleep-test-only-token-20261107 WORKER_SECRET=sleep-test-worker-secret-20261107 \
  HOST_CODEX_AUTH_FILE=/tmp/openbot-sleep-no-host-auth \
  node apps/worker/dist/worker.mjs >"${SLEEP_TEST_LOG:-/tmp/openbot-sleep-worker.log}" 2>&1 &
worker_pid=$!
for ((i=0;i<60;i++)); do
  if curl -fsS "http://127.0.0.1:$WORKER_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
SLEEP_TEST_CONTAINER="$computer" SLEEP_TEST_WORKER_URL="http://127.0.0.1:$WORKER_PORT" \
  SLEEP_TEST_COMPUTER_URL="$BOTD_URL" pnpm --filter @open-bot/worker exec tsx scripts/computer-sleep-smoke.ts
