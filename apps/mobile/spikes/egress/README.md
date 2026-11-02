# Background egress spike (phase 0.6)

A throwaway spike that answers one question before phase 3 is built: can a push wake the app on the owner's phone and start a foreground service that holds a websocket, in every state the phone can be in?
The results are in [`docs/mobile-plan.md`](../../../../docs/mobile-plan.md#06-background-egress-spike).

## What it is

- `android/SpikeMessagingService.kt` takes FCM's service slot from React Native Firebase.
  RN Firebase's own service does nothing with messages (its receiver hands them to JavaScript), so the app's notifications keep working.
  For a data message with `type: "egress-spike"`, it starts the foreground service natively, with no JavaScript involved.
- `android/EgressSpikeService.kt` is a `specialUse` foreground service.
  It opens one websocket to `wss://echo.websocket.org`, checks that a message comes back, holds the connection for 60 seconds under a partial wake lock, then stops.
- `android/SpikeLog.kt` writes one JSON line per event to logcat (tag `EgressSpike`) and to `egress-spike.log` in the app's external files directory, so the log survives the phone being unplugged.
  Each push also records the device state: screen, Doze, battery saver, the battery optimization exemption and the app standby bucket.
- `with-egress-spike.js` is the config plugin that adds all of this.
  It's only on in a build made with `OPENBOT_EGRESS_SPIKE=1`; normal builds don't include it.
- `send.mjs` sends the high-priority FCM data message, signed with the worker's service account.

## Running it

```sh
cd apps/mobile
OPENBOT_EGRESS_SPIKE=1 EXPO_PUBLIC_APP_URL=https://openbot.up.railway.app npx expo prebuild --platform android --no-install
(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a)
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Open the app and send a test notification from Settings, which creates the messaging service and logs the FCM token.
Then, for each case:

```sh
token=$(adb shell cat /sdcard/Android/data/dev.openbot.mobile/files/egress-spike.log | grep '"token"' | tail -1 | jq -r .token)
railway run --service worker -- node spikes/egress/send.mjs "$token" screen-off-doze
adb shell cat /sdcard/Android/data/dev.openbot.mobile/files/egress-spike.log
```

A case passes when the log shows `push`, `fgs-started`, `ws-open`, `ws-echo` and `ws-held`.
`fgs-start-refused` (with `ForegroundServiceStartNotAllowedException`) or no `push` line at all is a failure.

Build without `OPENBOT_EGRESS_SPIKE` (and with `npx expo prebuild --clean`) to go back to the normal app.
