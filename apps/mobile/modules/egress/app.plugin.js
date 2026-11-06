// @ts-check
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const RN_FIREBASE = "io.invertase.firebase.messaging";

/**
 * The phone connection's app manifest changes (the module's own manifest has the service and
 * the boot receiver):
 *
 * - With Firebase: FCM's service and receiver become the module's, which handle `egress-needed`
 *   natively and pass everything else to React Native Firebase's.
 * - Development builds (no Firebase): a receiver for the same data from adb.
 * - Backup rules that keep the phone connection's preferences out of backups.
 *
 * @param {import("expo/config").ExpoConfig} config
 * @param {{ firebase?: boolean; development?: boolean }} options
 */
module.exports = function withEgress(config, { firebase = false, development = false } = {}) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    manifest.manifest.$["xmlns:tools"] ??= "http://schemas.android.com/tools";
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    application.$["android:fullBackupContent"] = "@xml/openbot_backup_rules";
    application.$["android:dataExtractionRules"] = "@xml/openbot_data_extraction_rules";

    const ours = (/** @type {{ $: Record<string, string> }} */ entry) =>
      entry.$["android:name"].startsWith("dev.openbot.egress.") ||
      entry.$["android:name"].startsWith(`${RN_FIREBASE}.ReactNativeFirebaseMessaging`);
    const services = (application.service ?? []).filter((entry) => !ours(entry));
    const receivers = (application.receiver ?? []).filter((entry) => !ours(entry));

    if (firebase) {
      services.push(
        /** @type {any} */ ({
          $: {
            "android:name": "dev.openbot.egress.EgressMessagingService",
            "android:exported": "false",
          },
          "intent-filter": [
            { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
          ],
        }),
        // Only one service gets FCM's messages; the module's extends this one.
        /** @type {any} */ ({
          $: {
            "android:name": `${RN_FIREBASE}.ReactNativeFirebaseMessagingService`,
            "tools:node": "remove",
          },
        }),
      );
      receivers.push(
        /** @type {any} */ ({
          $: {
            "android:name": "dev.openbot.egress.EgressMessagingReceiver",
            "android:exported": "true",
            "android:permission": "com.google.android.c2dm.permission.SEND",
          },
          "intent-filter": [
            { action: [{ $: { "android:name": "com.google.android.c2dm.intent.RECEIVE" } }] },
          ],
        }),
        // Its replacement drops egress pushes, so they never start headless JavaScript.
        /** @type {any} */ ({
          $: {
            "android:name": `${RN_FIREBASE}.ReactNativeFirebaseMessagingReceiver`,
            "tools:node": "remove",
          },
        }),
      );
    }

    if (development)
      receivers.push(
        /** @type {any} */ ({
          $: {
            "android:name": "dev.openbot.egress.DebugWakeReceiver",
            "android:exported": "true",
            // Only the shell (adb) and the system hold it.
            "android:permission": "android.permission.DUMP",
          },
          "intent-filter": [
            {
              action: [
                { $: { "android:name": "dev.openbot.egress.DEBUG_WAKE" } },
                { $: { "android:name": "dev.openbot.egress.DEBUG_PAIR" } },
              ],
            },
          ],
        }),
      );

    application.service = services;
    application.receiver = receivers;
    return config;
  });
};
