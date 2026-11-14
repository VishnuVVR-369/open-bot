#!/usr/bin/env bash
# Runs a command against a throwaway pgvector Postgres: `scripts/test/pg.sh <command...>`.
# Needs Docker. Exports TEST_DATABASE_URL for the command and always removes the container
# afterwards, with its data: the image declares a volume for it, which `docker rm` without `-v`
# leaves behind, a full database per run. The database is `postgres`, or TEST_PG_DATABASE when set.
# The normal app database is never contacted.
set -euo pipefail
if [[ $# -eq 0 ]]; then
  echo "usage: scripts/test/pg.sh <command...>" >&2
  exit 2
fi
container="openbot-test-pg-$$"
database="${TEST_PG_DATABASE:-postgres}"
cleanup() { docker rm -fv "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# The same image as docker-compose.yml, so pgvector migrations behave identically. CI starts its
# Postgres with this script too.
# Every integration suite migrates its own database in one transaction, which locks each table and
# index it creates, and `pnpm test:integration` runs dozens of suites at once: with Postgres's
# default of 64 locks per transaction, 20 suites migrating together already ran out of lock slots
# ("out of shared memory"). 256 lets 60 migrate together.
docker run --detach --name "$container" -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB="$database" \
  --publish 127.0.0.1::5432 pgvector/pgvector:pg17 -c max_locks_per_transaction=256 >/dev/null
ready=""
for ((i = 0; i < 60; i++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d "$database" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ -n "$ready" ]] || { echo "Postgres did not become ready" >&2; exit 1; }
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
export TEST_DATABASE_URL="postgres://postgres:test-only@127.0.0.1:${port}/${database}"
"$@"
