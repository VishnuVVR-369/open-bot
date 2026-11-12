// Keeps environment access in one module per app (scripts/lint/env-modules.mjs) and keeps every
// variable those modules read documented: in the configuration reference, and in .env.example when
// the app reads the root .env in development.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ESLint } from "eslint";
import { ENV_MODULES } from "../lint/env-modules.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const REFERENCE = "apps/site/src/app/docs/reference/configuration/page.mdx";

/**
 * Variables a `.env`-reading app takes that `.env.example` leaves out, each with its reason. Every
 * one is still in the configuration reference.
 */
const NOT_IN_ENV_EXAMPLE = {
  NODE_ENV: "set by Node.js tooling and by Railway",
  PORT: "set by Railway for each service; next dev would take it too",
  RAILWAY_PUBLIC_DOMAIN: "set by Railway",
  GOOGLE_BASE_URL: "tests only: a stand-in for Google",
  NOTION_MCP_URL: "tests only: a stand-in for Notion",
  TELEGRAM_API_BASE_URL: "tests only: a stand-in for Telegram",
  FCM_API_BASE_URL: "tests only: a stand-in for Firebase Cloud Messaging",
  OPEN_BOT_PLAN_BASE_URL: "tests only: rehearses the plan fallback",
};

/** Variables `.env.example` sets that no env module reads, each with its reason. */
const READ_ELSEWHERE = {
  BETTER_AUTH_SECRET: "read by the sign-in library itself",
  OPENBOT_NEXT_DIST_DIR: "read by apps/web/next.config.ts, a development option",
};

/**
 * The variables an env module's source reads: `process.env.NAME`, `process.env["NAME"]`,
 * `const { NAME } = process.env`, and the keys of a zod env schema. Throws on a read it can't name,
 * such as `process.env[name]`, so no variable slips past the checks below.
 */
function variablesIn(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/process\.env\.([A-Za-z_]\w*)/g)) names.add(name);
  for (const [, , name] of source.matchAll(/process\.env\[\s*(["'`])([A-Za-z_]\w*)\1\s*\]/g))
    names.add(name);
  for (const [, list] of source.matchAll(/\{([^}]*)\}\s*=\s*process\.env\b/g))
    for (const item of list.split(",")) {
      const name = item.trim().split(/[\s:=]/)[0];
      if (name) names.add(name);
    }
  for (const [, name] of source.matchAll(/^\s+["']?([A-Z][A-Z0-9_]*)["']?\s*:/gm)) names.add(name);
  const unnamed = source.match(/process\.env\[(?!\s*(["'`])[A-Za-z_]\w*\1\s*\])[^\]]*\]/);
  if (unnamed) throw new Error(`Read each variable by its literal name, not ${unnamed[0]}`);
  return names;
}

const variablesOf = (path) => variablesIn(read(path));

/** `.env.example` sets the variable, or shows it commented out. */
const lists = (text, name) => new RegExp(`^#?\\s*${name}=`, "m").test(text);

test("the scanner names every way an env module can read a variable", () => {
  const source = [
    "const a = process.env.DOT_READ;",
    'const b = process.env["BRACKET_READ"];',
    "const { DESTRUCTURED, RENAMED: renamed, DEFAULTED = 1 } = process.env;",
    "const schema = z.object({",
    "  SCHEMA_KEY: z.string(),",
    '  "QUOTED_KEY": z.string(),',
    "});",
  ].join("\n");
  assert.deepEqual([...variablesIn(source)].sort(), [
    "BRACKET_READ",
    "DEFAULTED",
    "DESTRUCTURED",
    "DOT_READ",
    "QUOTED_KEY",
    "RENAMED",
    "SCHEMA_KEY",
  ]);
  assert.throws(() => variablesIn("const v = process.env[name];"), /literal name/);
});

test("every env module exists and reads something", () => {
  for (const { path } of ENV_MODULES) {
    assert.ok(existsSync(new URL(path, ROOT)), `${path} is listed but missing`);
    assert.ok(variablesOf(path).size > 0, `${path} reads no variables`);
  }
});

test("the configuration reference documents every variable an app reads", () => {
  const reference = read(REFERENCE);
  const missing = ENV_MODULES.flatMap(({ path }) =>
    [...variablesOf(path)]
      .filter((name) => !reference.includes(`\`${name}\``) && !reference.includes(`\`${name}=`))
      .map((name) => `${name} (${path})`),
  );
  assert.deepEqual(missing, [], `Document these in ${REFERENCE}`);
});

test(".env.example lists every variable the apps that read .env take", () => {
  const example = read(".env.example");
  const missing = ENV_MODULES.filter((module) => module.dotenv).flatMap(({ path }) =>
    [...variablesOf(path)]
      .filter((name) => !(name in NOT_IN_ENV_EXAMPLE) && !lists(example, name))
      .map((name) => `${name} (${path})`),
  );
  assert.deepEqual(missing, [], "Add these to .env.example, with a comment");
});

test(".env.example sets nothing that no app reads", () => {
  const used = new Set(ENV_MODULES.flatMap(({ path }) => [...variablesOf(path)]));
  const set = [...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(
    ([, name]) => name,
  );
  const stale = set.filter((name) => !used.has(name) && !(name in READ_ELSEWHERE));
  assert.deepEqual(stale, [], "Remove these from .env.example, or read them in an env module");
});

test("process.env is refused outside the env modules, scripts and tests", async () => {
  const eslint = new ESLint();
  const code =
    "export const a = process.env.FOO;\nconst { env } = process;\nexport const b = env;\n";
  const errors = async (filePath) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.filter((m) => m.ruleId === "no-restricted-properties").length;
  };
  for (const file of [
    "apps/worker/src/services/probe.ts",
    "apps/web/src/components/probe.tsx",
    "apps/mobile/src/app/probe.tsx",
    "packages/db/src/probe.ts",
    "packages/memory/src/probe.ts",
    "apps/worker/src/services/probe.config.ts",
  ])
    assert.equal(await errors(file), 2, file);
  for (const file of [
    ...ENV_MODULES.map((module) => module.path),
    "apps/worker/scripts/probe.ts",
    "apps/worker/src/probe.test.ts",
    "apps/web/next.config.ts",
    "apps/mobile/app.config.ts",
    "packages/db/drizzle.config.ts",
    "packages/db/src/testing.ts",
  ])
    assert.equal(await errors(file), 0, file);
});
