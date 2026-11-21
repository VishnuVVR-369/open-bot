# tools/showcase

Typed demo data and screenshots for UI review: a busy week for a startup founder, seeded into its own `openbot_showcase` database.
It is a development tool, never deployed; product code and test stand-ins don't belong here.
The full guide (servers, sign-in, what is and isn't seeded) is `tools/showcase/README.md`.

## Entry points

- `tools/showcase/seed.ts` (`pnpm --filter @open-bot/showcase seed`): drops and recreates `openbot_showcase`, runs the migrations, inserts everything.
- `tools/showcase/content-chats.ts`, `content-rest.ts`, `content-model-logs.ts`: the story, one function per feature (`seedTeam`, `seedAutomations`, ...).
- `tools/showcase/lib.ts`: relative dates (`ago`, `fromNow`), schedule occurrences, vault sealing and run-step builders (`msg`, `cmd`, `tool`, ...); `assets.ts` renders fake screenshots and page thumbnails with Playwright's Chromium.
- `tools/showcase/auth.mjs` signs in on :3200 and saves a Playwright storage state; `shoot.mjs` screenshots its list of routes (main pages, every teammate, the main chats) in light or dark; add a new screen to that list.

## Invariants

- The seed only ever writes the database named `openbot_showcase`, and refuses any other target.
  It reads the server from `SHOWCASE_DATABASE_URL` or `DATABASE_URL` and swaps the database name.
- Every insert is typed against the Drizzle schema in `@open-bot/db`, so a schema change that breaks the seed fails `pnpm typecheck`.
- Dates are relative to the moment of seeding, so labels like "2h ago" read naturally; seeding twice resets the same story.
- Fake values only: tokens, cards and logins are made up, and vault items are sealed with the local `ENCRYPTION_KEY`.
- The showcase web app runs on :3200 and pages on :3401, so it never disturbs the dev stack on :3000.
  Port 3200 is shared with `apps/site` dev; never run both.
- A new feature screen gets demo data here, so the `openbot-ui-review` skill can screenshot it.

## Tests

- `pnpm typecheck` checks the seed (`tools/showcase/tsconfig.json`).
- CI seeds a fresh database in the integration job: `bash scripts/test/pg.sh bash -c 'SHOWCASE_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @open-bot/showcase seed'`.

## Docs

- `tools/showcase/README.md`
- `.agents/skills/openbot-ui-review/SKILL.md`
