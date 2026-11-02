// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

/**
 * The status bar icon for notifications (`ic_notification`): Android draws it as a white
 * silhouette, so it's its own image, rendered at each density in assets/notification-icon.
 */
module.exports = function withNotificationIcon(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const source = path.join(config.modRequest.projectRoot, "assets", "notification-icon");
      const res = path.join(config.modRequest.platformProjectRoot, "app", "src", "main", "res");
      for (const density of DENSITIES) {
        const dir = path.join(res, `drawable-${density}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(source, `${density}.png`), path.join(dir, "ic_notification.png"));
      }
      return config;
    },
  ]);
};
