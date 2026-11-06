#!/usr/bin/env node
// Checks the merged Android manifest for what the phone connection needs (modules/egress).
// CI runs it after building each variant:
//
//   node scripts/check-egress-manifest.mjs <merged AndroidManifest.xml> [--firebase] [--development]
import { readFileSync } from "node:fs";

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.error(
    "Usage: check-egress-manifest.mjs <AndroidManifest.xml> [--firebase] [--development]",
  );
  process.exit(2);
}
const firebase = flags.includes("--firebase");
const development = flags.includes("--development");
const xml = readFileSync(path, "utf8");
const failures = [];
const check = (ok, message) => ok || failures.push(message);

/** The element for a component, with its children, or null. */
function component(tag, name) {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*android:name="${name.replaceAll(".", "\\.")}"[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`,
  );
  return xml.match(pattern)?.[0] ?? null;
}
const has = (element, text) => element !== null && element.includes(text);

for (const permission of [
  "INTERNET",
  "ACCESS_NETWORK_STATE",
  "WAKE_LOCK",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "RECEIVE_BOOT_COMPLETED",
  "POST_NOTIFICATIONS",
])
  check(
    xml.includes(`<uses-permission android:name="android.permission.${permission}"`),
    `missing permission ${permission}`,
  );

const service = component("service", "dev.openbot.egress.EgressService");
check(
  has(service, 'android:foregroundServiceType="specialUse"'),
  "EgressService is not a specialUse service",
);
check(has(service, 'android:exported="false"'), "EgressService is exported");
check(
  has(service, "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"),
  "EgressService has no special use subtype",
);
check(
  has(component("receiver", "dev.openbot.egress.BootReceiver"), "BOOT_COMPLETED"),
  "no boot receiver",
);

check(
  xml.includes('android:fullBackupContent="@xml/openbot_backup_rules"') &&
    xml.includes('android:dataExtractionRules="@xml/openbot_data_extraction_rules"'),
  "the app doesn't use the phone connection's backup rules",
);

const messaging = component("service", "dev.openbot.egress.EgressMessagingService");
const receiver = component("receiver", "dev.openbot.egress.EgressMessagingReceiver");
const rnService = component(
  "service",
  "io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService",
);
const rnReceiver = component(
  "receiver",
  "io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver",
);
if (firebase) {
  check(
    has(messaging, "com.google.firebase.MESSAGING_EVENT"),
    "EgressMessagingService doesn't get FCM messages",
  );
  check(
    has(receiver, "com.google.android.c2dm.intent.RECEIVE") &&
      has(receiver, 'android:permission="com.google.android.c2dm.permission.SEND"'),
    "EgressMessagingReceiver doesn't replace React Native Firebase's receiver",
  );
  check(rnService === null, "React Native Firebase's messaging service is still there");
  check(
    rnReceiver === null,
    "React Native Firebase's receiver is still there (it would start JavaScript)",
  );
} else {
  check(
    messaging === null && receiver === null,
    "egress messaging components in a build without Firebase",
  );
}

const debug = component("receiver", "dev.openbot.egress.DebugWakeReceiver");
if (development)
  check(
    has(debug, 'android:permission="android.permission.DUMP"'),
    "no DUMP-protected debug wake receiver",
  );
else check(debug === null, "the debug wake receiver is in a non-development build");

if (failures.length) {
  console.error(`${path}:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Manifest OK (${[firebase && "firebase", development && "development"].filter(Boolean).join(", ") || "normal, no firebase"})`,
);
