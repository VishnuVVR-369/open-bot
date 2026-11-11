// Proves the `open-bot/table-owners` lint rule fires, and keeps packages/db/src/owners.ts honest:
// every table has an owner, every writer still moving really writes its table (so the list only
// shrinks), and an owner exists once nothing is left to move into it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ESLint } from "eslint";
import { TABLE_OWNERS } from "../../packages/db/src/owners.ts";
import tableOwners, { TABLE_NAMES, sqlWrites } from "../lint/table-owners.mjs";

const eslint = new ESLint();

/** The table-owners messages ESLint reports for `code` as if it lived at `filePath`. */
async function ownerErrors(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "open-bot/table-owners").map((m) => m.message);
}

/** The tables the files matching `pattern` write, owner or not. */
const writes = new ESLint({
  overrideConfig: {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "open-bot": tableOwners },
    rules: { "open-bot/table-owners": "off", "open-bot/table-writes": "error" },
  },
});
async function tablesWrittenBy(pattern) {
  const tables = new Set();
  for (const result of await writes.lintFiles([pattern]))
    for (const m of result.messages)
      if (m.ruleId === "open-bot/table-writes") tables.add(m.message);
  return tables;
}

test("every table in the schema has an owner, and nothing else does", () => {
  assert.deepEqual(Object.keys(TABLE_OWNERS).sort(), [...TABLE_NAMES.values()].sort());
});

test("Drizzle writes outside the owner fail, through aliases and multi-line calls", async () => {
  const file = "apps/web/src/lib/server/probe.ts";
  for (const code of [
    'import { pages } from "@open-bot/db";\nexport const f = (db: never) => (db as any).delete(pages);\n',
    'import { pages as p } from "@open-bot/db";\nexport const f = (db: any) => db.update(\n  p,\n).set({});\n',
    'import { pages } from "@open-bot/db/schema";\nexport const f = (tx: any) => tx.insert(pages).values({});\n',
    'import { sql } from "drizzle-orm";\nimport { pages } from "@open-bot/db";\nexport const q = sql`update ${pages} set pinned = true`;\n',
  ]) {
    const errors = await ownerErrors(file, code);
    assert.equal(errors.length, 1, code);
    assert.match(errors[0], /Only apps\/worker\/src\/services\/pages\.ts writes `pages`/);
  }
});

test("raw SQL writes outside the owner fail", async () => {
  const file = "apps/web/src/lib/server/probe.ts";
  for (const code of [
    'export const q = "update pages set pinned = true";\n',
    "export const q = `insert into pages(id) values($1)`;\n",
    'export const q = "delete from pages where id = $1";\n',
    "export const q = `update pages\n  set pinned = $1`;\n",
  ]) {
    assert.equal((await ownerErrors(file, code)).length, 1, code);
  }
});

test("reads, other tables' namesakes and prose are not writes", async () => {
  const file = "apps/web/src/lib/server/probe.ts";
  for (const code of [
    'import { pages } from "@open-bot/db";\nexport const f = (db: any) => db.select().from(pages);\n',
    "const pages = { id: 1 };\nexport const f = (db: any) => db.update(pages);\n",
    'export const m = "Couldn\'t update pages. Try again.";\n',
    'export const q = "select * from pages where id = $1";\n',
    'export const f = (map: Map<string, number>) => map.delete("pages");\n',
  ]) {
    assert.deepEqual(await ownerErrors(file, code), [], code);
  }
  assert.deepEqual(sqlWrites("update the pages set"), []);
});

test("the owner, a folder owner's files and listed writers may write", async () => {
  const drizzle = (table) =>
    `import { ${table} } from "@open-bot/db";\nexport const f = (db: any) => db.delete(${table});\n`;
  assert.deepEqual(await ownerErrors("apps/worker/src/services/pages.ts", drizzle("pages")), []);
  assert.deepEqual(await ownerErrors("apps/worker/src/runs/probe.ts", drizzle("runs")), []);
  assert.deepEqual(
    await ownerErrors(
      "packages/memory/src/probe.ts",
      'export const q = "update runs set x = 1";\n',
    ),
    [],
  );
  assert.equal((await ownerErrors("apps/worker/src/runsx.ts", drizzle("runs"))).length, 1);
});

test("tests may write any table", async () => {
  const code =
    'import { pages } from "@open-bot/db";\nexport const f = (db: any) => db.delete(pages);\n';
  assert.deepEqual(await ownerErrors("apps/web/src/lib/server/probe.test.ts", code), []);
});

test("every writer still moving, or sharing columns, really writes the table", async () => {
  const stale = [];
  for (const [table, owner] of Object.entries(TABLE_OWNERS)) {
    for (const path of [...(owner.moving ?? []), ...(owner.shared ?? []).map((s) => s.by)]) {
      if (!existsSync(path)) stale.push(`${table}: ${path} does not exist`);
      else if (!(await tablesWrittenBy(path.endsWith("/") ? `${path}**/*.ts` : path)).has(table))
        stale.push(`${table}: ${path} no longer writes it; remove it`);
    }
  }
  assert.deepEqual(stale, []);
});

test("an owner exists once no writer is left to move into it", () => {
  const missing = Object.entries(TABLE_OWNERS)
    .filter(([, owner]) => !owner.moving?.length && !existsSync(owner.owner))
    .map(([table, owner]) => `${table}: ${owner.owner}`);
  assert.deepEqual(missing, []);
});

test("the owners file names no runtime imports, so ESLint can load it", () => {
  const source = readFileSync("packages/db/src/owners.ts", "utf8");
  assert.doesNotMatch(source, /^import (?!type )/m);
});
