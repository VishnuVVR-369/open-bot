import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-*/**",
      "apps/site/out/**",
      "apps/site/.media/**",
      "**/dist/**",
      "**/release/**",
      "**/drizzle/**",
      "**/next-env.d.ts",
      "packages/agent/src/protocol/**",
      "apps/web/src/components/ui/**",
      "playwright-report/**",
      "test-results/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/.expo/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: [
      "apps/web/**/*.tsx",
      "apps/web/**/*.ts",
      "apps/site/**/*.tsx",
      "apps/site/**/*.ts",
      "apps/mobile/**/*.tsx",
      "apps/mobile/**/*.ts",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Expo config plugins run in Node as CommonJS.
    files: ["apps/mobile/plugins/**/*.js", "apps/mobile/modules/*/app.plugin.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
