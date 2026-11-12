import { defineConfig } from "vitest/config";
import { sharedTest } from "../../vitest.shared.mjs";

// Unit tests for the app's platform-free logic, in Node.
export default defineConfig({ test: { ...sharedTest, include: ["src/**/*.test.ts"] } });
