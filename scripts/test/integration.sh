#!/usr/bin/env bash
# Every `*.integration.test.ts` suite, each in its own fresh database. Uses TEST_DATABASE_URL when
# it is set (CI), otherwise starts a throwaway Postgres with scripts/test/pg.sh (needs Docker).
# Extra arguments go to turbo, for example `--affected`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  exec bash scripts/test/pg.sh bash scripts/test/integration.sh "$@"
fi
pnpm exec turbo run test:integration "$@"
