# Computer verification

Branch: `feat/mobile-web-view`.
Verification date: 2026-11-04.
The emulator is a separate `openbot-phase2-test` Android 36 Google APIs ARM64 device.
The tests use `dev.openbot.mobile.dev`, a disposable Postgres database, and a disposable computer container.
The owner's existing local database, running computer container, and signed daily app are not used by these fixtures.

## Recorded checks

- botd: 26 unit tests passed, including protected lease timeouts, duplicate input, wrong/changed site, explicit clearing, CDP failure, restart quarantine that a timeout never discards, and reporting the preempted run.
- Disposable mobile API suite: 34 tests passed, including operation-first persistence, cancellation races, shared screen locks, restart states, partial hand-back reconciliation, a botd refusal leaving the request open, one return for takeovers that ended together, and repeated safety-pause notifications.
- Mobile: 126 unit tests passed, including notification actions, cold-start routing and lost-response recovery.
- Web: 16 unit tests passed.
- Typechecks passed for botd, worker, API, mobile and web.
- Repository lint and formatting passed.
- Android debug build passed with the local SMS consent module and WebView.
- Expo Android export passed, including the bundled viewer.
- Maestro computer flow passed: sign-in, screens list, sleeping screen without auto-wake, explicit wake, takeover, trackpad toggle, keyboard entry, Back confirmation, hand-back and the note persisted in Postgres.
- Real botd/CDP fixture passed: a successful submit releases only after the code disappears; a code retained in page text blocks bot screenshots and hand-back, even after input clearing, until the page becomes safe.
- Maestro code sheet passed: live preview, focused site, manual code entry, submission and verified hand-back.
- The remote fixture also verified actual keyboard characters, left-click and long-press right-click events arriving through the emulator's bundled WebView and VNC connection.

The emulator code test uses manual entry, not a real carrier SMS.
It does not establish real-phone SMS consent, real FCM delivery, signed release behavior, or a deployed teammate continuing after a real website's sign-in.
Those remain the plan's final real-phone acceptance checks.
The code probe deliberately retains owner control for inaccessible documents, closed shadow roots, or embedded canvas/video/plugin content it cannot verify through the DOM.
Navigate away from unsupported content before handing back; after a restart, explicit recovery discards the browser pages.

## Repeat automated checks

From the repository root:

```sh
pnpm test:mobile-api
pnpm --filter @open-bot/botd test
pnpm --filter @open-bot/mobile test
pnpm --filter @open-bot/web test
pnpm --filter @open-bot/mobile check:viewer
pnpm lint
pnpm format:check
```

`test:mobile-api` creates, migrates and removes its own database container.
Normal unit tests skip the database integration tests; run the dedicated command above too.
Regenerate `src/computer/viewer-html.ts` with `pnpm --filter @open-bot/mobile build:viewer` after editing the browser source or updating noVNC.
The generated module carries noVNC's MPL notice and source link, and has no runtime library downloads.

## Disposable stack for the emulator

The sample passwords and tokens below belong only to the disposable fixtures.
Do not point these scripts at the normal or production database.
Build botd and the computer image, then run a separate computer and Postgres:

```sh
pnpm --filter @open-bot/botd build
docker compose build computer
docker run -d --name openbot-phase2-computer --shm-size=1g \
  --security-opt seccomp=unconfined -p 127.0.0.1:17070:7000 \
  -e BOTD_TOKEN=phase2-local-computer-test-token \
  --mount type=bind,source="$PWD/apps/botd/dist/botd.mjs",target=/opt/botd/botd.mjs,readonly \
  open-bot-computer:dev
docker run -d --name openbot-phase2-postgres \
  -e POSTGRES_PASSWORD=phase2-local-db-only -e POSTGRES_DB=openbot_phase2_test \
  -p 127.0.0.1:15439:5432 pgvector/pgvector:pg17
export SCREEN_TEST_DATABASE_URL=postgres://postgres:phase2-local-db-only@127.0.0.1:15439/openbot_phase2_test
DATABASE_URL="$SCREEN_TEST_DATABASE_URL" pnpm --filter @open-bot/db migrate
```

Start the web server and worker in separate terminals, with the same database and worker token:

```sh
DATABASE_URL="$SCREEN_TEST_DATABASE_URL" OWNER_EMAIL=phase2@example.test \
  BETTER_AUTH_URL=http://localhost:3100 WORKER_URL=http://localhost:4101 \
  NEXT_PUBLIC_WORKER_WS_URL=ws://localhost:4101 \
  WORKER_SECRET=phase2-local-worker-test-token \
  pnpm --filter @open-bot/web exec next dev --port 3100
```

```sh
DATABASE_URL="$SCREEN_TEST_DATABASE_URL" BOTD_URL=http://127.0.0.1:17070 \
  BOTD_TOKEN=phase2-local-computer-test-token WORKER_PORT=4101 \
  WORKER_SECRET=phase2-local-worker-test-token APP_URL=http://localhost:3100 \
  HOST_CODEX_AUTH_FILE=/tmp/openbot-phase2-no-auth \
  pnpm --filter @open-bot/worker exec tsx src/index.ts
```

Create the disposable owner in the web setup UI as `phase2@example.test`, with password `phase2-emulator-fixture-only`.
The test scripts accept `E2E_EMAIL` and `E2E_PASSWORD` overrides for this local test account.
The real CDP tests do not invoke a model or need a Codex login.

Build the development app as in README, setting `EXPO_PUBLIC_APP_URL=http://localhost:3100`, install it on the test emulator, and start Metro with that same URL and `APP_VARIANT=development`.
Without `APP_VARIANT`, Metro bundles the Firebase code the development build lacks, and the app stops at "No Firebase App".
Forward all three ports:

```sh
adb reverse tcp:3100 tcp:3100
adb reverse tcp:4101 tcp:4101
adb reverse tcp:8081 tcp:8081
```

With Maestro on PATH, or `MAESTRO_BIN` pointing to its executable:

```sh
node scripts/test-computer-ui.mjs
SCREEN_TEST_UI=1 node scripts/test-screen-codes.mjs
```

`MOBILE_E2E_DEVICE` selects the emulator; the default is `emulator-5554`.
`SCREEN_TEST_COMPUTER_URL`, `SCREEN_TEST_WORKER_URL`, `SCREEN_TEST_WORKER_SECRET` and `SCREEN_TEST_BOTD_TOKEN` point the code test at a stack with other ports or tokens.
The first script signs in and tests normal takeover.
The second drives real botd/CDP safety cases and, with `SCREEN_TEST_UI=1`, the signed-in app's code sheet.
Without that flag it runs only the server safety checks.
Each script removes its teammate, screen and request fixtures afterward.
Maestro screenshots and logs stay under the ignored `apps/mobile/.maestro-results/` directory.
Stop the test processes and remove the two `openbot-phase2-*` containers when finished.
