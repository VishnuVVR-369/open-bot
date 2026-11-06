#!/usr/bin/env node
// Pairs a development build's phone connection with a local open-bot, without the app's screens:
// it registers the device through the web API (with the e2e owner session) and hands the
// credential to the app over adb (DebugWakeReceiver, development builds only).
//
//   node scripts/egress-pair-dev.mjs [--serial <adb serial>] [--mode fallback|always]
//
// The phone reaches the local stack through `adb reverse tcp:3000 tcp:3000` and `tcp:4001`,
// which this script sets up.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const serial = option("--serial", process.env.ANDROID_SERIAL);
const mode = option("--mode", "fallback");
const appUrl = option("--app-url", "http://localhost:3000");
const pkg = "dev.openbot.mobile.dev";
const adbPath = path.join(
  process.env.ANDROID_HOME ?? "/opt/homebrew/share/android-commandlinetools",
  "platform-tools",
  "adb",
);
const adb = (...rest) =>
  execFileSync(adbPath, [...(serial ? ["-s", serial] : []), ...rest], { encoding: "utf8" });

const root = path.resolve(import.meta.dirname, "../../..");
const session = JSON.parse(
  readFileSync(path.join(root, "e2e/.auth/owner.json"), "utf8"),
).cookies.find((cookie) => cookie.name === "better-auth.session_token");
if (!session) throw new Error("No owner session in e2e/.auth/owner.json; run the e2e setup first.");

async function rpc(procedure, input) {
  const response = await fetch(`${appUrl}/api/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `better-auth.session_token=${session.value}`,
    },
    body: JSON.stringify({ json: input }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${procedure}: ${response.status} ${JSON.stringify(body)}`);
  return body.json;
}

for (const port of ["3000", "4001"]) adb("reverse", `tcp:${port}`, `tcp:${port}`);

// The first DEBUG_PAIR without a secret only makes (and logs) the install's device id.
const broadcast = (extras) =>
  // 0x20 (FLAG_INCLUDE_STOPPED_PACKAGES): an app that was never opened still gets it.
  adb(
    "shell",
    "am",
    "broadcast",
    "-f",
    "0x20",
    "-a",
    "dev.openbot.egress.DEBUG_PAIR",
    "-p",
    pkg,
    ...extras,
  );
broadcast([]);
const prefs = adb("shell", "run-as", pkg, "cat", "shared_prefs/openbot_egress.xml");
const deviceId = /name="device_id">([^<]+)</.exec(prefs)?.[1];
if (!deviceId) throw new Error(`No device id in the app's preferences:\n${prefs}`);

const model = adb("shell", "getprop", "ro.product.model").trim() || "Android phone";
const { secret, generation } = await rpc("egress/registerDevice", {
  deviceId,
  name: model,
  pushToken: null,
});
broadcast([
  "--es",
  "secret",
  secret,
  "--ei",
  "generation",
  String(generation),
  "--es",
  "appUrl",
  appUrl,
  "--es",
  "phoneMode",
  mode,
]);
await rpc("egress/setPhoneMode", { mode });
console.log(`Paired ${model} (${deviceId}) as generation ${generation}, phone mode ${mode}.`);
