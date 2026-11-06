// @ts-check
const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Signs release builds with open-bot's own release key instead of the debug key. The key stays
 * outside the repo; its location and passwords come from Gradle properties, normally in
 * ~/.gradle/gradle.properties:
 *
 *   OPENBOT_RELEASE_STORE_FILE=/absolute/path/to/open-bot-release.jks
 *   OPENBOT_RELEASE_STORE_PASSWORD=...
 *   OPENBOT_RELEASE_KEY_ALIAS=open-bot
 *   OPENBOT_RELEASE_KEY_PASSWORD=...
 *
 * Without them, a release build fails instead of quietly using the debug key: passkeys and the
 * domain association only trust the release key.
 */
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents;
    if (gradle.includes("OPENBOT_RELEASE_STORE_FILE")) return config;
    gradle = gradle.replace(
      /signingConfigs \{\n(\s*)debug \{/,
      (match, indent) =>
        `signingConfigs {\n${indent}release {\n` +
        `${indent}    if (project.hasProperty("OPENBOT_RELEASE_STORE_FILE")) {\n` +
        `${indent}        storeFile file(OPENBOT_RELEASE_STORE_FILE)\n` +
        `${indent}        storePassword OPENBOT_RELEASE_STORE_PASSWORD\n` +
        `${indent}        keyAlias OPENBOT_RELEASE_KEY_ALIAS\n` +
        `${indent}        keyPassword OPENBOT_RELEASE_KEY_PASSWORD\n` +
        `${indent}    }\n` +
        `${indent}}\n${indent}debug {`,
    );
    // The template signs release builds with the debug key; use the release key.
    gradle = gradle.replace(
      /(release \{\n(\s*)\/\/ Caution![^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/,
      "$1signingConfig signingConfigs.release",
    );
    gradle += `
gradle.taskGraph.whenReady { graph ->
    // Only the tasks that write a signed APK or bundle; release lint and resources don't need the key.
    if (graph.allTasks.any { it.project == project && it.name in ["packageRelease", "signReleaseBundle"] }
            && !project.hasProperty("OPENBOT_RELEASE_STORE_FILE")) {
        throw new GradleException("Set OPENBOT_RELEASE_STORE_FILE and the other OPENBOT_RELEASE_* properties in ~/.gradle/gradle.properties to build a release (see apps/mobile/README.md).")
    }
}
`;
    config.modResults.contents = gradle;
    return config;
  });
};
