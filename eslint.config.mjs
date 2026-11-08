import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { builtinModules } from "node:module";
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
    // @open-bot/domain runs in browsers and React Native; only its server folder may use Node.
    files: ["packages/domain/src/**/*.ts"],
    ignores: ["packages/domain/src/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^(node:.*|(${builtinModules.join("|")})(/.*)?)$`,
              message: "packages/domain is isomorphic. Put Node-only code in src/server.",
            },
            {
              regex: "(^|/)server(/.*)?$",
              message:
                "packages/domain is isomorphic and must not import its Node-only server folder.",
            },
          ],
        },
      ],
    },
  },
  {
    // Code that runs on a phone or in the browser can't load node:crypto.
    files: [
      "apps/mobile/**/*.{ts,tsx}",
      "packages/api/**/*.ts",
      "apps/web/src/components/**/*.{ts,tsx}",
      "apps/web/src/lib/client/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@open-bot/domain/server",
              message: "@open-bot/domain/server is Node-only. Use it from server code.",
            },
          ],
        },
      ],
    },
  },
  {
    // Expo config plugins run in Node as CommonJS.
    files: ["apps/mobile/plugins/**/*.js", "apps/mobile/modules/*/app.plugin.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
