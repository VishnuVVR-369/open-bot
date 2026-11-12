// Keeps environment access in one module per app (scripts/lint/env-modules.mjs) and keeps every
// variable those modules read documented: in the configuration reference, and in .env.example when
// the app reads the root .env in development.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { DEV_SECRETS } from "../../packages/domain/src/server/secrets.ts";
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
  OPENBOT_NEXT_DIST_DIR: "read by apps/web/next.config.ts, a development option",
};

/** A property's name when it is written literally: `NAME`, `"NAME"` or `` `NAME` ``. */
function literalName(node, computed) {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return null;
}

/** `process.env` or `process["env"]`. */
const isProcessEnv = (node) =>
  node?.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === "process" &&
  literalName(node.property, node.computed) === "env";

/** Calls `fn(node, parent)` for every node of a syntax tree. */
function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === "string") walk(child, fn, node);
  }
}

/** An identifier that refers to a variable, not a property name or an object key. */
const isReference = (node, parent) =>
  !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed) &&
  !(parent?.type === "Property" && parent.key === node && !parent.computed);

/** Calls that may take the whole environment: an env schema parses it, by its keys. */
const PARSERS = new Set(["parse", "safeParse", "parseEnv"]);
const calleeName = (callee) =>
  callee.type === "Identifier"
    ? callee.name
    : callee.type === "MemberExpression"
      ? callee.property.name
      : null;

/**
 * The variables an env module's source reads, from its syntax tree: `process.env.NAME` (also
 * optional and bracketed with a literal), `const { NAME } = process.env`, and the upper-case keys
 * of an object, such as a zod env schema, which parses `process.env` whole (directly, or through a
 * parameter that defaults to it and only goes to the parser). Throws on any other use of
 * `process.env` or `process`, such as `process.env[name]` or an alias, so no variable slips past
 * the checks.
 */
function variablesIn(source) {
  const { ast } = tseslint.parser.parseForESLint(source, { sourceType: "module", loc: true });
  const names = new Set();
  const lines = source.split("\n");
  const refuse = (node) => {
    const line = node.loc.start.line;
    throw new Error(
      `Read each variable by its literal name (line ${line}): ${lines[line - 1].trim()}`,
    );
  };
  /** Parameters that default to `process.env`; each may only be handed to the parser. */
  const sources = new Set();
  const parsed = (node, parent) =>
    parent?.type === "CallExpression" &&
    parent.arguments.includes(node) &&
    PARSERS.has(calleeName(parent.callee));
  walk(ast, (node, parent) => {
    if (isProcessEnv(node)) {
      if (parent.type === "MemberExpression" && parent.object === node) {
        const name = literalName(parent.property, parent.computed);
        if (name === null) refuse(parent);
        names.add(name);
      } else if (
        parent.type === "VariableDeclarator" &&
        parent.init === node &&
        parent.id.type === "ObjectPattern"
      ) {
        for (const property of parent.id.properties) {
          const name =
            property.type === "Property" ? literalName(property.key, property.computed) : null;
          if (name === null) refuse(property);
          names.add(name);
        }
      } else if (parsed(node, parent)) {
        // The schema's keys name what it reads.
      } else if (
        parent.type === "AssignmentPattern" &&
        parent.right === node &&
        parent.left.type === "Identifier"
      ) {
        sources.add(parent.left.name);
      } else refuse(node);
    } else if (node.type === "Identifier" && node.name === "process" && isReference(node, parent)) {
      // Only `process.<something>`: `const { env } = process` or an alias would hide the reads.
      if (!(parent.type === "MemberExpression" && parent.object === node)) refuse(node);
    } else if (node.type === "Property") {
      const name = literalName(node.key, node.computed);
      if (name && /^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
    }
  });
  walk(ast, (node, parent) => {
    if (node.type !== "Identifier" || !sources.has(node.name) || !isReference(node, parent)) return;
    const declaration = parent.type === "AssignmentPattern" && parent.left === node;
    if (!declaration && !parsed(node, parent)) refuse(node);
  });
  return names;
}

const variablesOf = (path) => variablesIn(read(path));

/** `.env.example` sets the variable, or shows it commented out. */
const lists = (text, name) => new RegExp(`^#?\\s*${name}=`, "m").test(text);

test("the scanner names every way an env module can read a variable", () => {
  const source = [
    "const a = process.env.DOT_READ;",
    'const b = process.env["BRACKET_READ"];',
    "const c = process.env?.OPTIONAL_READ;",
    'const e = process["env"].BRACKET_ENV_READ;',
    "process.exit(1);",
    "const d = process.env?.[`OPTIONAL_BRACKET`];",
    "const { DESTRUCTURED, RENAMED: renamed, DEFAULTED = 1 } = process.env;",
    "const schema = z.object({",
    "  SCHEMA_KEY: z.string(),",
    '  "QUOTED_KEY": z.string(),',
    "});",
    "const inline = z.object({ INLINE_KEY: z.string() }).parse(process.env);",
    "export function readEnv(source = process.env) { return parseEnv(schema, source); }",
  ].join("\n");
  assert.deepEqual([...variablesIn(source)].sort(), [
    "BRACKET_ENV_READ",
    "BRACKET_READ",
    "DEFAULTED",
    "DESTRUCTURED",
    "DOT_READ",
    "INLINE_KEY",
    "OPTIONAL_BRACKET",
    "OPTIONAL_READ",
    "QUOTED_KEY",
    "RENAMED",
    "SCHEMA_KEY",
  ]);
  for (const unnamed of [
    "const v = process.env[name];",
    "const v = process.env?.[name];",
    "const env = process.env;",
    "const { ...rest } = process.env;",
    "use(process.env);",
    'const v = process["env"][name];',
    "const { env } = process;",
    "const p = process;",
    "function readEnv(source = process.env) { return Number(source.FALLBACK_PORT ?? parseEnv(schema, source)); }",
  ])
    assert.throws(() => variablesIn(unnamed), /literal name/, unnamed);
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

test(".env.example's secrets are the public defaults production refuses", () => {
  const example = Object.fromEntries(
    [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map(([, name, value]) => [
      name,
      value,
    ]),
  );
  for (const [name, value] of Object.entries(DEV_SECRETS))
    assert.equal(example[name], value, `.env.example's ${name} must be DEV_SECRETS.${name}`);
  const unguarded = Object.keys(example).filter(
    (name) => /SECRET|TOKEN|KEY/.test(name) && !(name in DEV_SECRETS) && example[name] !== "",
  );
  assert.deepEqual(unguarded, [], "Add these secrets' example values to DEV_SECRETS");
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
