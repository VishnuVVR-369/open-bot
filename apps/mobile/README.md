# open-bot for Android

Your teammates on your phone: a home briefing, chats with live replies and attachments, search, and approvals you can decide from the notification shade.
It's an Expo app (React Native) that talks to your open-bot deployment through the same API the web app uses (`packages/api`).
It's installed over USB; there's no Play Store listing.

## Using the pocket inbox

Home shows what needs you, recent activity, teammates and a briefing of work finished while you were away.
Use the web app to take over the computer or review suggested instructions.
Chats shows unread badges and previews; use New chat for a direct conversation or a group, and @-mention teammates to choose who answers.
The chat menu lets you rename or archive a conversation; archiving keeps its history.

Attach a photo, take one with the camera, or pick a file from the composer.
Failed uploads can be retried or removed before sending.
Images, Markdown, text and CSV/TSV files open in the app; tables scroll in both directions.
PDFs and other formats open in a compatible app on the phone.
The microphone adds dictation to the current draft; leaving that composer cancels recognition.
Replies offer copy, read aloud, ratings and feedback, with an option to remember a lesson or try again.
You can steer a working teammate with another message, stop it, or retry a failed or stopped turn.

Use the header's search and notification buttons to find earlier work.
Search finds teammates, chats, messages and pages; links to a teammate's reply load older history before scrolling to it.
If loading history fails, use Retry to continue.
Loaded history stays in place when newer replies arrive.
A chat becomes read across devices after fresh history has loaded while it is visible; failed refreshes keep it unread.

Approvals supports Approve, Deny and Always allow, with saved rules available from its menu.
Notification approvals can be decided without opening the app; purchases use Review and require the phone's authentication check before approval.
Reply on a message notification sends directly to its teammate, including in a group chat.

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
APP_VARIANT=development EXPO_PUBLIC_APP_URL=http://localhost:3000 pnpm start
# In a second terminal, also in apps/mobile:
APP_VARIANT=development EXPO_PUBLIC_APP_URL=http://localhost:3000 pnpm android --no-bundler
```

Run prebuild again whenever `app.config.ts`, a config plugin, or a native dependency changes.
The development variant has its own app data and no Firebase configuration; it uses password sign-in against the local server.
Both apps own the `openbot` auth scheme, so select `open-bot dev` and `Just once` when Android asks which app should open a development link.
Run `pnpm test` for platform-free logic and mounted React hook regressions, and `pnpm typecheck` for TypeScript checks.

## Pocket inbox tests

From the repository root, `pnpm test:mobile-api` checks durable dispatch, FCM fan-out and retry-safe uploads against disposable Postgres.
The normal database is not contacted by that command.
`pnpm e2e --grep-invert @agent` checks the web and RPC regression against the running local stack.

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
See [TESTING.md](TESTING.md) for recorded device evidence and the checks still deferred.
Screenshots and logs are local in `.maestro-results/`, which is ignored by Git.

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

### Background connection experiment

Phase 0's native FCM and foreground-service experiment lives in [`spikes/egress`](spikes/egress/README.md).
It is included only when `OPENBOT_EGRESS_SPIKE=1` during prebuild.
Normal builds contain the passkey module and notifications, without the experiment's services or token logging.
Run a clean prebuild without that variable before installing a normal build again.

## How it fits together

- `src/app`: Expo Router screens for sign-in, Home, Chats, Approvals, new direct/group chats, notifications, search, file previews, approval rules and Settings.
- `src/lib/api.ts`: the typed API client; the session cookie lives in SecureStore (`src/lib/auth.ts`).
- `src/lib/realtime.tsx` and `src/lib/live-stream.ts`: the live stream while the app is open, which resumes the open chat from its last event after a reconnect.
- `src/lib/lock.ts`: asks for your fingerprint on open and after five minutes away.
- `src/push`: notification channels, rendering pushes (also while the app is closed, in `background.ts`), Approve and Deny, purchase Review and inline Reply.
- `plugins/`: config plugins for release signing, the status bar icon, and the native theme (alerts and the text cursor use the app's palette and fonts).
