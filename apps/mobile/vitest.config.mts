import { defineConfig } from "vitest/config";

// Unit tests for the app's platform-free logic, in Node.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
