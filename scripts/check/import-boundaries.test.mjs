// Proves the import boundaries in eslint.config.mjs fire: @open-bot/domain stays isomorphic, and code
// that can reach a phone or a browser never loads @open-bot/domain/server. Lints in memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

/** The boundary messages ESLint reports for `code` as if it lived at `filePath`. */
async function boundaryErrors(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

const SERVER =
  'import { issueToken } from "@open-bot/domain/server";\nexport const x = issueToken;\n';
const SERVER_DYNAMIC = 'export const x = () => import("@open-bot/domain/server");\n';

test("the isomorphic domain folders can't import Node or the server folder", async () => {
  const file = "packages/domain/src/pages/probe.ts";
  for (const code of [
    'import { createHash } from "node:crypto";\nexport const x = createHash;\n',
    'import { createHash } from "crypto";\nexport const x = createHash;\n',
    'import { readFile } from "fs/promises";\nexport const x = readFile;\n',
    'import { signPageVersion } from "../server";\nexport const x = signPageVersion;\n',
    'export * from "../server/tokens";\n',
    'export const x = () => import("node:crypto");\n',
    'export const x = () => import("../server");\n',
  ]) {
    assert.equal((await boundaryErrors(file, code)).length, 1, code);
  }
});

test("the domain server folder and plain imports are allowed", async () => {
  const node = 'import { createHash } from "node:crypto";\nexport const x = createHash;\n';
  assert.deepEqual(await boundaryErrors("packages/domain/src/server/probe.ts", node), []);
  const sibling =
    'import { z } from "zod";\nimport { slugify } from "../teammates";\nexport const x = [z, slugify];\n';
  assert.deepEqual(await boundaryErrors("packages/domain/src/pages/probe.ts", sibling), []);
});

test("chat-core can't import Node, platform UI or server-only packages", async () => {
  const file = "packages/chat-core/src/probe.ts";
  for (const source of [
    "node:crypto",
    "fs",
    "react-native",
    "react-dom/client",
    "next/link",
    "expo-router",
    "lucide-react",
    "lucide-react-native",
    "@react-native-async-storage/async-storage",
    "@react-native-firebase/app",
    "@notifee/react-native",
    "@expo/vector-icons",
    "@open-bot/db",
    "@open-bot/integrations/server",
    "@open-bot/memory",
    "@open-bot/agent",
    "@open-bot/egress",
    "@open-bot/domain/server",
  ]) {
    const code = `import * as x from "${source}";\nexport { x };\n`;
    assert.equal((await boundaryErrors(file, code)).length, 1, source);
    assert.equal((await boundaryErrors(file, `export * from "${source}";\n`)).length, 1, source);
    const dynamic = `export const x = () => import("${source}");\n`;
    assert.equal((await boundaryErrors(file, dynamic)).length, 1, source);
  }
  // A package whose name only starts with a Node module's is not Node.
  for (const source of ["path-to-regexp", "assert-never", "url-parse"]) {
    const code = `import * as x from "${source}";\nexport { x };\n`;
    assert.deepEqual(await boundaryErrors(file, code), [], source);
  }
  const allowed =
    'import { isRunActive } from "@open-bot/domain";\nimport type { RunView } from "@open-bot/api";\nexport const x: [typeof isRunActive, RunView?] = [isRunActive];\n';
  assert.deepEqual(await boundaryErrors(file, allowed), []);
});

test("mobile, the API contract and web client code can't import the server entry", async () => {
  for (const file of [
    "apps/mobile/src/lib/probe.ts",
    "apps/mobile/src/app/probe.tsx",
    "packages/api/src/probe.ts",
    "apps/web/src/components/probe.tsx",
    "apps/web/src/lib/client/probe.ts",
    "apps/web/src/lib/auth-client.ts",
    "apps/web/src/app/(auth)/auth-form.tsx",
  ]) {
    assert.equal((await boundaryErrors(file, SERVER)).length, 1, file);
    assert.equal((await boundaryErrors(file, SERVER_DYNAMIC)).length, 1, file);
  }
});

test("web server code may import the server entry", async () => {
  for (const file of ["apps/web/src/lib/server/probe.ts", "apps/web/src/app/api/probe/route.ts"]) {
    assert.deepEqual(await boundaryErrors(file, SERVER), [], file);
  }
});
