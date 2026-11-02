// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require("expo/config-plugins");

/**
 * The phase 0.6 spike (see README.md here): a native FCM service that starts a `specialUse`
 * foreground service holding one websocket. Only in builds made with OPENBOT_EGRESS_SPIKE=1.
 */
const SOURCES = path.join(__dirname, "android");
const PACKAGE_DIR = ["app", "src", "main", "java", "dev", "openbot", "mobile", "spike"];
const RN_FIREBASE_SERVICE = "io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService";

/** @param {import("expo/config").ExpoConfig} config */
module.exports = function withEgressSpike(config) {
  config = withDangerousMod(config, [
    "android",
    async (config) => {
      const target = path.join(config.modRequest.platformProjectRoot, ...PACKAGE_DIR);
      fs.mkdirSync(target, { recursive: true });
      for (const file of fs.readdirSync(SOURCES))
        fs.copyFileSync(path.join(SOURCES, file), path.join(target, file));
      return config;
    },
  ]);

  config = withAppBuildGradle(config, (config) => {
    const line = 'implementation "com.google.firebase:firebase-messaging"';
    if (!config.modResults.contents.includes(line))
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies \{\n/,
        // The same Firebase release React Native Firebase uses.
        `dependencies {\n    implementation platform("com.google.firebase:firebase-bom:35.0.2")\n    ${line}\n`,
      );
    return config;
  });

  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    manifest.manifest.$["xmlns:tools"] ??= "http://schemas.android.com/tools";
    const permissions = (manifest.manifest["uses-permission"] ??= []);
    for (const name of [
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    ])
      if (!permissions.some((permission) => permission.$["android:name"] === name))
        permissions.push({ $: { "android:name": name } });

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const services = (application.service ??= []).filter(
      (service) => !service.$["android:name"].startsWith(".spike."),
    );
    services.push(
      /** @type {any} */ ({
        $: {
          "android:name": ".spike.EgressSpikeService",
          "android:exported": "false",
          "android:foregroundServiceType": "specialUse",
        },
        property: [
          {
            $: {
              "android:name": "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
              "android:value": "Carries your teammates' web traffic over this phone's connection",
            },
          },
        ],
      }),
      {
        $: { "android:name": ".spike.SpikeMessagingService", "android:exported": "false" },
        "intent-filter": [
          { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
        ],
      },
      // Only one service gets FCM's messages; the spike's extends this one.
      /** @type {any} */ ({ $: { "android:name": RN_FIREBASE_SERVICE, "tools:node": "remove" } }),
    );
    application.service = services.filter(
      (service, index, all) =>
        all.findIndex((other) => other.$["android:name"] === service.$["android:name"]) === index,
    );
    return config;
  });
};
