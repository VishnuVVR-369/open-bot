#!/usr/bin/env bash
# A long run's progress on phones, end to end: a real computer container, Postgres and the built
# worker, with stand-ins for the model and for FCM. The run waits on an approval and ends; the
# smoke checks every push the worker sent. RUN_PROGRESS_RELAY (an agent-device command) also shows
# each push on a development build of the phone app; PROGRESS_TEST_HOLD=<dir> holds the stack
# before the run (until <dir>/go exists) and after it (until <dir>/finish exists), with its
# addresses in <dir>/stack.env, so a web server and a signed-in phone can join it. Needs Docker and the computer image
# (pnpm computer:build). Independent containers and storage only; never touches the normal compose
# project or Railway.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
computer="openbot-progress-test-computer-$$"
database="openbot-progress-test-db-$$"
volume="openbot-progress-test-home-$$"
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
docker run -d --name "$computer" -e BOTD_TOKEN=progress-test-only-token-20261122 \
  -e MAX_SCREENS=2 -p 127.0.0.1::7000 \
  --shm-size=2g --security-opt seccomp=unconfined --mount "source=$volume,target=/home" \
  --mount "type=bind,source=$root/apps/botd/dist/botd.mjs,target=/opt/botd/botd.mjs,readonly" "$image" >/dev/null
docker run -d --name "$database" -e POSTGRES_PASSWORD=progress-test-only \
  -e POSTGRES_DB=openbot_progress_test -p 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$database" pg_isready -U postgres -d openbot_progress_test >/dev/null 2>&1; then break; fi
  sleep 1
done
db_port="$(docker port "$database" 5432/tcp | head -1 | sed 's/.*://')"
computer_port="$(docker port "$computer" 7000/tcp | head -1 | sed 's/.*://')"
export DATABASE_URL="postgres://postgres:progress-test-only@127.0.0.1:$db_port/openbot_progress_test"
export BOTD_URL="http://127.0.0.1:$computer_port"
for ((i=0;i<60;i++)); do
  if curl -fsS "$BOTD_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
pnpm --filter @open-bot/db migrate
docker exec "$database" psql -U postgres -d openbot_progress_test -c "insert into settings (id,chatgpt_auth_source) values (1,'device');" >/dev/null
# A disposable credential: the model is the stand-in, so no real account is used.
docker exec "$computer" sh -c 'printf %s "{\"OPENAI_API_KEY\":\"sk-progress-test-only-not-a-real-key\"}" > /home/bot/.codex/auth.json && chown bot:bot /home/bot/.codex/auth.json && chmod 600 /home/bot/.codex/auth.json'
export WORKER_PORT="${PROGRESS_TEST_WORKER_PORT:-14093}"
export PROGRESS_TEST_FIXTURE_PORT="${PROGRESS_TEST_FIXTURE_PORT:-14798}"
# The FCM stand-in's service account: a key made for this run, and the stand-in's token endpoint.
export FCM_SERVICE_ACCOUNT_JSON="$(node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.stdout.write(JSON.stringify({
  project_id: "open-bot-progress-test",
  client_email: "worker@open-bot-progress-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: `http://127.0.0.1:${process.env.PROGRESS_TEST_FIXTURE_PORT}/token`,
}));')"
OPEN_BOT_PLAN_BASE_URL="http://127.0.0.1:$PROGRESS_TEST_FIXTURE_PORT/model" \
  FCM_API_BASE_URL="http://127.0.0.1:$PROGRESS_TEST_FIXTURE_PORT/fcm" \
  BOTD_TOKEN=progress-test-only-token-20261122 WORKER_SECRET=progress-test-worker-secret-20261122 \
  HOST_CODEX_AUTH_FILE=/tmp/openbot-progress-no-host-auth \
  node apps/worker/dist/worker.mjs >"${PROGRESS_TEST_LOG:-/tmp/openbot-progress-worker.log}" 2>&1 &
worker_pid=$!
for ((i=0;i<60;i++)); do
  if curl -fsS "http://127.0.0.1:$WORKER_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
hold="${PROGRESS_TEST_HOLD:-}"
wait_for() { while [[ ! -e "$hold/$1" ]]; do sleep 1; done; }
if [[ -n "$hold" ]]; then
  mkdir -p "$hold"
  printf 'DATABASE_URL=%s\nWORKER_URL=%s\nWORKER_SECRET=%s\n' "$DATABASE_URL" \
    "http://127.0.0.1:$WORKER_PORT" progress-test-worker-secret-20261122 >"$hold/stack.env"
  echo "Stack ready: $hold/stack.env. Create $hold/go to start the run."
  wait_for go
fi
status=0
PROGRESS_TEST_WORKER_URL="http://127.0.0.1:$WORKER_PORT" \
  pnpm --filter @open-bot/worker exec tsx scripts/run-progress-smoke.ts || status=$?
if [[ -n "$hold" ]]; then
  echo "Run done ($status). Create $hold/finish to remove the stack."
  wait_for finish
fi
exit "$status"
