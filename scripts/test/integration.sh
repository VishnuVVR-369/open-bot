#!/usr/bin/env bash
# Every `*.integration.test.ts` suite, each in its own fresh database. Uses TEST_DATABASE_URL when
# it is set, otherwise starts a throwaway Postgres with scripts/test/pg.sh (needs Docker), as CI does.
# Extra arguments go to turbo, for example `--affected`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  exec bash scripts/test/pg.sh bash scripts/test/integration.sh "$@"
fi
pnpm exec turbo run test:integration "$@"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-timeout=60000 --test-force-exit scripts/test/e2e-shared-state.test.mjs
