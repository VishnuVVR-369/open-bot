---
name: openbot-mobile
description: Use for any open-bot Android work - the Expo app in apps/mobile, the emulator, or the owner's phone. Lists setup steps and device gotchas agents keep rediscovering.
---

# open-bot mobile

Read `apps/mobile/README.md` first. It has the dev, release, signing, and Firebase steps.

## Setup that gets missed

- Metro and dev builds need `APP_VARIANT=development` (package `dev.openbot.mobile.dev`). Without it Firebase config is missing.
- Forward every local port the app uses: `adb reverse` for 3000 (web), 8081 (Metro), 4001 (worker websockets), 3400 (pages). A stuck "Reconnecting" usually means 4001 is not forwarded.
- Run prebuild again after changing `app.config.ts`, a config plugin, or a native dependency.
- Release builds need JDK 17 (`JAVA_HOME=/opt/homebrew/opt/openjdk@17`) and the `OPENBOT_RELEASE_*` Gradle properties.
- Firebase has two files: `google-services.json` goes in the app; the service-account JSON goes in the worker's `FCM_SERVICE_ACCOUNT_JSON`.

## Device gotchas

- A black screenshot is the app lock or biometric prompt (a secure window), not a crash. Reloads lock the app again. The emulator PIN is 1111.
- The development client drops the first deep link and a share that cold-starts the app. Release builds don't. Don't "fix" this in native code.
- The owner's phone is a Xiaomi. Installs need "Install via USB" enabled, the screen unlocked, and the user to approve a prompt. Batch such asks into one message.
- A freshly installed app is in the stopped state and receives no broadcasts until opened.

## Rules

- Never type credentials on screen or screenshot a filled sign-in form. Ask for secrets through the secret prompt.
- Check each changed screen in light, dark, portrait, and landscape.
- Skip tests that need long idle waits (Doze) or unplugging. List them as untested.
- Restore any device setting you change (timezone, server URL, dark mode).
