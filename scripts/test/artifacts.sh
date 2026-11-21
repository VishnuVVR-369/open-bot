#!/usr/bin/env bash
# Builds the worker and pages bundles, then boots each one with scripts/ci/boot-artifacts.mjs
# (start, wait for /healthz, SIGTERM, clean exit) on a fresh, migrated database. Uses
# TEST_DATABASE_URL when it is set, otherwise starts a throwaway Postgres with scripts/test/pg.sh
# (needs Docker), as CI does. Extra arguments go to the build's turbo run, for example `--force`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
pnpm exec turbo run build --filter=@open-bot/worker --filter=@open-bot/pages --output-logs=errors-only "$@"
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  exec bash scripts/test/pg.sh node scripts/ci/boot-artifacts.mjs
fi
exec node scripts/ci/boot-artifacts.mjs
