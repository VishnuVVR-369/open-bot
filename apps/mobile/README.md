# open-bot for Android

The Expo app (React Native) for open-bot: your teammates, chats, approvals, the computer's screens and pages on your phone.
It talks to your open-bot deployment through the same RPC contract the web app serves (`packages/api`), and is installed over USB; there is no Play Store listing.
What the app does for its user is described on the site, in `apps/site/src/app/docs/flows/android-app/page.mdx`.
This README is for building, configuring and testing it.

## What you need

- Node and pnpm, as for the rest of the repo (`pnpm install` at the root).
- JDK 17 (`brew install openjdk@17`). Gradle doesn't run on newer JDKs yet.
- The Android SDK with platform 36, build-tools 36 and NDK 27 (Android Studio, or `brew install --cask android-commandlinetools`).
- A phone with USB debugging on, or an emulator.

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools   # or ~/Library/Android/sdk
```

## Configuration

| Variable                        | What it's for                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_APP_URL`           | The open-bot web app the phone talks to. Defaults to `https://openbot.up.railway.app`.                   |
| `GOOGLE_SERVICES_JSON`          | Path to the Firebase config, if it isn't `apps/mobile/google-services.json`.                             |
| `APP_VARIANT`                   | `development` builds `dev.openbot.mobile.dev` alongside the signed daily app. Leave unset for a release. |
| `EXPO_PUBLIC_E2E_NOTIFICATIONS` | Set to `1` only in the local Metro session used by the Maestro notification tests.                       |

`EXPO_PUBLIC_*` values are built into the JavaScript bundle, so set them before `pnpm start` or a release build.

## Develop against a local stack

Run the web app and the worker as usual (`pnpm dev`), then:

```sh
cd apps/mobile
APP_VARIANT=development pnpm prebuild --clean
adb reverse tcp:3000 tcp:3000       # the phone's localhost:3000 is your computer's
adb reverse tcp:8081 tcp:8081       # Metro
adb reverse tcp:4001 tcp:4001       # the worker's websockets, for watching screens
adb reverse tcp:3400 tcp:3400       # the pages service, for opening pages
APP_VARIANT=development EXPO_PUBLIC_APP_URL=http://localhost:3000 pnpm start
# In a second terminal, also in apps/mobile:
APP_VARIANT=development EXPO_PUBLIC_APP_URL=http://localhost:3000 pnpm android --no-bundler
```

Run prebuild again whenever `app.config.ts`, a config plugin, or a native dependency changes.
The development variant has its own app data and no Firebase configuration; it uses password sign-in against the local server.
Both apps own the `openbot` auth scheme, so select `open-bot dev` and `Just once` when Android asks which app should open a development link.
Run `pnpm test` for platform-free logic and mounted React hook regressions, and `pnpm typecheck` for TypeScript checks.

## Pocket inbox tests

From the repository root, `pnpm test:integration` checks durable dispatch, FCM fan-out and retry-safe uploads against disposable Postgres.
The normal database is not contacted by that command.
`E2E_STACK=dev pnpm e2e --grep-invert @agent` checks the web and RPC regression against the running local stack.

Install Maestro locally and keep the local web, worker and Metro running.
Start Metro with the development variant and the notification-test flag:

```sh
cd apps/mobile
APP_VARIANT=development EXPO_PUBLIC_APP_URL=http://localhost:3000 \
  EXPO_PUBLIC_E2E_NOTIFICATIONS=1 pnpm start
```

Then, from the repository root, with the local owner's credentials in your environment:

```sh
export E2E_EMAIL=your-local-owner@example.com
export E2E_PASSWORD=your-local-owner-password
MOBILE_E2E_DEVICE=your-adb-device-id pnpm test:mobile-ui
```

`MAESTRO_BIN` can point to a Maestro executable outside `PATH`.
On MIUI, accept the USB-install prompts for Maestro's two helper APKs.
`MAESTRO_NO_REINSTALL=1` reuses those helpers on later runs with the same Maestro version.
`MOBILE_E2E_FLOW=flows/inline-reply.yaml` selects a focused flow instead of the complete suite.
`MOBILE_E2E_MANUAL=1` holds fixtures after the flow for fingerprint/background checks or failure diagnosis; POST `/finish` to the local fixture URL printed by the runner to clean them up afterward.
Failed flows still exit unsuccessfully after that cleanup.
The suite clears only the development app's data, creates its own teammate and approvals, and removes its database fixtures afterward.
It covers password sign-in, sending and streaming a reply, deciding in the app, a live decision from another device, notification approval, a stale notification action, purchase Review, and Android inline Reply.

The notification tests inject an FCM-shaped payload into the development app, then use the actual Notifee notification, Android action and authenticated RPC implementation.
Replyable messages use Android MessagingStyle so MIUI exposes the native inline editor.
The flow waits for that editor before entering text and sending.
On MIUI it enters text through ADB because the clipboard helper is blocked in SystemUI.
This phone can also ignore injected Send taps, so the flow allows 60 seconds for the owner to tap the native Send button before checking delivery.
It exercises Android RemoteInput and the background handler without calling the application handler or send RPC directly.
Injection requires both a development build and `EXPO_PUBLIC_E2E_NOTIFICATIONS=1`; it is excluded from release bundles and provides no authentication bypass.
Screenshots and logs are local in `.maestro-results/`, which is ignored by Git.

`maestro/pages.yaml` is a focused flow for Pages, run on its own against a signed-in development app.
Pass a published page as `PAGE_ID`, for example `maestro test -e PAGE_ID=<page id> maestro/pages.yaml`.
It opens the page from a link, checks that it loads, opens Ask and the menu, and switches to an older version when there is one.
To check sharing, send a share with `adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "'https://example.com'" dev.openbot.mobile.dev`.
Do it while the app is open (or in the background): the development client's launcher drops a share that cold-starts the app, which a release build doesn't do.
To try the cold path in a development build, turn on "Don't keep activities" (`adb shell settings put global always_finish_activities 1`), leave the app, share, and turn it off again afterwards.

## Push notifications (Firebase)

Notifications are FCM data messages that the app renders itself, so approvals get Approve and Deny buttons.
Without a Firebase config the app builds and works, just without notifications.

1. Create a Firebase project, and add an Android app with the package name `dev.openbot.mobile`.
2. Download its `google-services.json` into `apps/mobile/` (it's gitignored: never commit it), then `pnpm prebuild`.
3. In the Firebase console, under Project settings → Service accounts, generate a private key.
4. Set the whole JSON as `FCM_SERVICE_ACCOUNT_JSON` on the worker (Railway: the `worker` service's variables).

Settings → Send a test notification checks the whole path.

## Release builds

Release builds are signed with your own release key, which never goes in the repo.

```sh
keytool -genkeypair -v -keystore ~/keys/open-bot-release.jks -alias open-bot \
  -keyalg RSA -keysize 4096 -validity 10000
```

Add it to `~/.gradle/gradle.properties`:

```properties
OPENBOT_RELEASE_STORE_FILE=/Users/you/keys/open-bot-release.jks
OPENBOT_RELEASE_STORE_PASSWORD=...
OPENBOT_RELEASE_KEY_ALIAS=open-bot
OPENBOT_RELEASE_KEY_PASSWORD=...
```

Without them a release build fails instead of falling back to the debug key.
Then build and install:

```sh
APP_VARIANT=production EXPO_PUBLIC_APP_URL=https://openbot.up.railway.app \
  EXPO_PUBLIC_E2E_NOTIFICATIONS=0 pnpm prebuild --clean
APP_VARIANT=production EXPO_PUBLIC_APP_URL=https://openbot.up.railway.app \
  EXPO_PUBLIC_E2E_NOTIFICATIONS=0 pnpm android:release
```

Keep the keystore backed up: an update signed with a different key can't be installed over the app.

### Passkeys and the domain association

Passkeys and verified links only trust apps signed with your release key.
Tell the web app its fingerprint:

```sh
keytool -list -v -keystore ~/keys/open-bot-release.jks -alias open-bot | grep SHA256
```

Set that value (`AB:CD:...`) as `ANDROID_CERT_SHA256` on the `web` service.
Several fingerprints can be given, comma-separated, for example a debug key's while developing.
`https://<your-app>/.well-known/assetlinks.json` then lists the app, and passkey sign-in accepts it.

In the signed app, open Settings → Add a passkey and confirm with your fingerprint.
After signing out, Use a passkey on the sign-in screen opens Android's Credential Manager.
Both the options and verification requests use Better Auth's Expo cookie jar, which carries the challenge cookie and stores the resulting session in SecureStore.
The Android binding is a local Expo module in `modules/passkey`; regenerate the native project after adding or changing its native dependencies.
Debug builds use password sign-in unless their signing certificate is explicitly allowed by the development server.

### Phone connection

The phone can carry teammates' browsing when your Mac is offline (or always, if you choose), through a native foreground service in the local Expo module [`modules/egress`](modules/egress).
A high-priority FCM data message wakes it without starting React Native; its protocol core is a plain Kotlin project in `modules/egress/core`, tested with `./gradlew test` there against the vectors in `packages/egress/test-vectors`.

Development builds have no Firebase, so a `DebugWakeReceiver` takes the same data from adb instead, and runs the same code.
It exists only in the development variant, and only the shell can reach it.
Pair a development build with the local stack without the app's screens, then send it a wake:

```sh
cd apps/mobile
node scripts/egress-pair-dev.mjs [--serial <adb serial>] [--mode fallback|always]
adb shell am broadcast -f 0x20 -a dev.openbot.egress.DEBUG_WAKE -p dev.openbot.mobile.dev \
  --es stage wake --es sentAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## How it fits together

- `src/app`: Expo Router screens. The tabs in `src/app/(tabs)` are Home, Chats, Approvals, Computer and Pages; the stack adds a chat, a page, a screen, a teammate, an approval, search, notifications, file previews, approval rules, new chat, share and Settings.
- `src/app/(tabs)/computer.tsx` and `src/app/screens/[screenId].tsx`: the screens list, live view, touch takeover, keyboard and hand-back.
- `src/computer/viewer.ts`: the browser client; `pnpm build:viewer` bundles noVNC into the generated `src/computer/viewer-html.ts`, and `pnpm check:viewer` checks it is current.
- `src/components`: shared UI; `src/components/chat` renders the timeline and composer, `src/components/computer` the WebView lifecycle, token handling, the code sheet and operation recovery.
- `src/lib`: platform-free logic with co-located tests. `api.ts` is the typed API client (the session cookie lives in SecureStore, `auth.ts`), `queries.ts` and `query.ts` hold the react-query hooks and keys, `realtime.tsx` and `live-stream.ts` the live stream (resuming the open chat from its last event after a reconnect), and `lock.ts` the fingerprint lock on open and after five minutes away.
- `src/push`: notification channels, rendering pushes (also while the app is closed, in `background.ts`), Approve and Deny, purchase Review and inline Reply.
- `src/theme`: the palette, light and dark, and color mixing.
- `modules/egress`: the phone connection (see above). `modules/passkey`: Android Credential Manager for passkeys. `modules/share-intent`: receiving shares from other apps. `modules/sms-consent`: Android's SMS User Consent, which passes only an unambiguous code to JavaScript.
- `plugins/`: config plugins for release signing, the status bar icon, and the native theme (alerts and the text cursor use the app's palette and fonts).
- `maestro/`: the Maestro UI flows run by `pnpm test:mobile-ui` from the repository root.
