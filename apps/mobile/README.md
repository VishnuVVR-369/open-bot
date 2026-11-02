# open-bot for Android

Your teammates on your phone: their chats, live replies, and approvals you can decide from the lock screen.
It's an Expo app (React Native) that talks to your open-bot deployment through the same API the web app uses (`packages/api`).
It's installed over USB; there's no Play Store listing.

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

| Variable               | What it's for                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_APP_URL`  | The open-bot web app the phone talks to. Defaults to `https://openbot.up.railway.app`. |
| `GOOGLE_SERVICES_JSON` | Path to the Firebase config, if it isn't `apps/mobile/google-services.json`.           |

`EXPO_PUBLIC_*` values are built into the JavaScript bundle, so set them before `pnpm start` or a release build.

## Develop against a local stack

Run the web app and the worker as usual (`pnpm dev`), then:

```sh
cd apps/mobile
pnpm prebuild                       # generates android/ (it's not committed)
adb reverse tcp:3000 tcp:3000       # the phone's localhost:3000 is your computer's
adb reverse tcp:8081 tcp:8081       # Metro
EXPO_PUBLIC_APP_URL=http://localhost:3000 pnpm start
pnpm android                        # builds and installs the development build
```

Run `pnpm prebuild` again whenever `app.config.ts`, a config plugin, or a native dependency changes.
Unit tests are `pnpm test` (Node, for the platform-free logic) and `pnpm typecheck`.

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
pnpm prebuild
pnpm android:release
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

- `src/app`: the screens, with Expo Router (sign-in, Teammates, Chats, Approvals, a chat, an approval, Settings).
- `src/lib/api.ts`: the typed API client; the session cookie lives in SecureStore (`src/lib/auth.ts`).
- `src/lib/realtime.tsx` and `src/lib/live-stream.ts`: the live stream while the app is open, which resumes the open chat from its last event after a reconnect.
- `src/lib/lock.ts`: asks for your fingerprint on open and after five minutes away.
- `src/push`: notification channels, rendering pushes (also while the app is closed, in `background.ts`), and the Approve and Deny buttons.
- `plugins/`: config plugins for release signing, the status bar icon, and the native theme (alerts and the text cursor use the app's palette and fonts).
