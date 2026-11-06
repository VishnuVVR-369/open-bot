// The phone's egress protocol core: plain Kotlin on the JVM, so it is tested without Android.
// The Android module compiles these same sources.
pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

plugins {
  // Downloads the JDK 17 toolchain when it isn't installed, so every machine builds the same.
  id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
  repositories { mavenCentral() }
}

rootProject.name = "egress-core"
