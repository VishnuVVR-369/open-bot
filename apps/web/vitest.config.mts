import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedTest } from "../../vitest.shared.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Server modules can be tested outside a React server.
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: { ...sharedTest, include: ["src/**/*.test.ts"] },
});
