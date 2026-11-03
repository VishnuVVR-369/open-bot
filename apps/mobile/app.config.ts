/// <reference types="node" />
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { palette } from "./src/theme/colors.ts";

/**
 * The open-bot Android app. Android only, installed over USB (see docs in README.md).
 *
 * - `EXPO_PUBLIC_APP_URL`: the open-bot to use (default: the deployed one).
 * - `GOOGLE_SERVICES_JSON`: the Firebase config for push notifications (not committed). Without
 *   it the app builds and works, but gets no notifications.
 * - `APP_VARIANT=development`: a separate "open-bot dev" app, installed next to the real one, for
 *   working against a local stack. It has no push notifications: Firebase knows only the real app.
 */

const family = (name: string, pkg: string, prefix: string, weights: [number, string][]) => ({
  fontFamily: name,
  fontDefinitions: weights.map(([weight, face]) => ({
    path: `node_modules/@expo-google-fonts/${pkg}/${face}/${prefix}_${face}.ttf`,
    weight,
  })),
});

const development = process.env.APP_VARIANT === "development";
const googleServices =
  process.env.GOOGLE_SERVICES_JSON ?? path.join(__dirname, "google-services.json");
const hasFirebase = !development && existsSync(googleServices);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: development ? "open-bot dev" : "open-bot",
  slug: "open-bot",
  version: "0.1.0",
  orientation: "portrait",
  scheme: "openbot",
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  platforms: ["android"],
  android: {
    package: development ? "dev.openbot.mobile.dev" : "dev.openbot.mobile",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      monochromeImage: "./assets/adaptive-icon-monochrome.png",
      backgroundColor: "#14161B",
    },
    predictiveBackGestureEnabled: false,
    // The camera for photos you attach, the microphone for dictation.
    permissions: ["android.permission.CAMERA", "android.permission.RECORD_AUDIO"],
    // Expo adds these by default; the app never draws over other apps or reads shared storage.
    // Photos and files are picked with Android's pickers, which need no storage permission.
    blockedPermissions: [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    ],
    ...(hasFirebase ? { googleServicesFile: googleServices } : {}),
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    ["expo-local-authentication", { faceIDPermission: false }],
    "expo-image",
    ["expo-image-picker", { cameraPermission: "Allow open-bot to take photos you attach." }],
    [
      "expo-speech-recognition",
      {
        microphonePermission: "Allow open-bot to hear you while you dictate.",
        speechRecognitionPermission: false,
        androidSpeechServicePackages: ["com.google.android.googlequicksearchbox"],
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash.png",
        imageWidth: 88,
        backgroundColor: palette.light.background,
        dark: { image: "./assets/splash-dark.png", backgroundColor: palette.dark.background },
      },
    ],
    [
      "expo-font",
      {
        android: {
          fonts: [
            family("Onest", "onest", "Onest", [
              [400, "400Regular"],
              [500, "500Medium"],
              [600, "600SemiBold"],
              [700, "700Bold"],
            ]),
            family("Familjen Grotesk", "familjen-grotesk", "FamiljenGrotesk", [
              [500, "500Medium"],
              [600, "600SemiBold"],
              [700, "700Bold"],
            ]),
            family("JetBrains Mono", "jetbrains-mono", "JetBrainsMono", [
              [400, "400Regular"],
              [500, "500Medium"],
            ]),
          ],
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 29,
          // WorkManager's Room database is created through reflection, including in R8 full mode.
          extraProguardRules:
            "-keep class * extends androidx.room.RoomDatabase { public <init>(); }",
          // The app resolves Notifee's core library from the Maven repo bundled with the package.
          extraMavenRepos: [
            pathToFileURL(
              path.join(
                path.dirname(require.resolve("@notifee/react-native/package.json")),
                "android/libs",
              ),
            ).href,
          ],
        },
      },
    ],
    // Push notifications, once there's a Firebase config to build with.
    ...(hasFirebase ? ["@react-native-firebase/app", "@react-native-firebase/messaging"] : []),
    "./plugins/with-release-signing",
    "./plugins/with-notification-icon",
    ["./plugins/with-android-theme", palette],
    // The phase 0.6 background egress spike, only in a build made for it (spikes/egress).
    ...(process.env.OPENBOT_EGRESS_SPIKE === "1" ? ["./spikes/egress/with-egress-spike"] : []),
  ],
  experiments: { typedRoutes: true },
  extra: { firebase: hasFirebase },
});
