import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";
import tableOwners from "./scripts/lint/table-owners.mjs";

/**
 * Node's built-in modules, bare or `node:` prefixed, with any subpath (`fs/promises`), but not a
 * package whose name only starts with one (`path-to-regexp`). `\x2F` is "/", which a selector regex
 * can't contain.
 */
const NODE_BUILTIN = `^(node:.*|(${builtinModules.filter((name) => !name.includes("/")).join("|")})(\\x2F.*)?)$`;

/**
 * Bans import sources, in static imports and re-exports and in dynamic `import()` with a literal
 * source. Each ban is an exact `name` or a `regex`; a regex must not contain "/", which ends a
 * selector regex.
 */
function forbidImports(bans) {
  const names = bans.filter((ban) => ban.name);
  const patterns = bans.filter((ban) => ban.regex);
  return {
    "no-restricted-imports": ["error", { paths: names, patterns }],
    "no-restricted-syntax": [
      "error",
      ...bans.map(({ name, regex, message }) => ({
        selector: name
          ? `ImportExpression[source.value=${JSON.stringify(name)}]`
          : `ImportExpression[source.value=/${regex}/]`,
        message,
      })),
    ],
  };
}

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
    rules: forbidImports([
      {
        regex: NODE_BUILTIN,
        message: "packages/domain is isomorphic. Put Node-only code in src/server.",
      },
      {
        regex: "(^|\\W)server(\\W.*)?$",
        message: "packages/domain is isomorphic and must not import its Node-only server folder.",
      },
    ]),
  },
  {
    // @open-bot/chat-core is shared by the web app and the phone app, so it can only use what both
    // can run: no Node, no platform UI, and no server-side packages.
    files: ["packages/chat-core/src/**/*.ts"],
    rules: forbidImports([
      {
        regex: NODE_BUILTIN,
        message: "packages/chat-core runs in the browser and in React Native; it can't use Node.",
      },
      {
        regex:
          "^(react-native|react-dom|next|expo|lucide-react|@react-native|@expo|@notifee)(\\W.*)?$",
        message: "packages/chat-core is platform-free. Render in the apps; return data from here.",
      },
      {
        regex: "^@open-bot.(db|integrations|memory|agent|egress|domain.server)(\\W.*)?$",
        message: "packages/chat-core is client code and can't use server-only packages.",
      },
    ]),
  },
  {
    // Code that can run on a phone or in the browser can't load node:crypto. Web server code
    // lives in lib/server and API routes; everything else may reach the client.
    files: ["apps/mobile/**/*.{ts,tsx}", "packages/api/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/lib/server/**", "apps/web/src/app/api/**"],
    rules: forbidImports([
      {
        name: "@open-bot/domain/server",
        message: "@open-bot/domain/server is Node-only. Use it from server code.",
      },
      {
        regex: "^@open-bot.integrations(\\W.*)?$",
        message: "@open-bot/integrations is Node-only. Use it from server code.",
      },
    ]),
  },
  {
    // The integrations and memory take their settings from each app's env module, so a stand-in
    // is one setting in each app and nothing reads the environment behind its back.
    files: ["packages/integrations/src/**/*.ts", "packages/memory/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Take it as config from the app's env module instead.",
        },
      ],
    },
  },
  {
    // Only a table's owner writes it (packages/db/src/owners.ts). Tests, seeds and stand-ins set
    // up whatever rows they need.
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts"],
    ignores: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "apps/*/scripts/**",
      "packages/db/src/testing.ts",
      "packages/db/src/migrate.ts",
    ],
    plugins: { "open-bot": tableOwners },
    rules: { "open-bot/table-owners": "error" },
  },
  {
    // Expo config plugins run in Node as CommonJS.
    files: ["apps/mobile/plugins/**/*.js", "apps/mobile/modules/*/app.plugin.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
