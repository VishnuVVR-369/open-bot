import { defineConfig } from "vitest/config";
import { sharedTest } from "../../vitest.shared.mjs";

export default defineConfig({ test: { ...sharedTest } });
