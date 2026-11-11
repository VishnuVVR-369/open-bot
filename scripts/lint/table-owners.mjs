// The `open-bot/table-owners` lint rule: only a table's owner writes it (packages/db/src/owners.ts).
// It reports a Drizzle `.insert(t)`, `.update(t)` or `.delete(t)` whose table `t` is imported from
// @open-bot/db, and SQL text that writes a table (`insert into t`, `update t set`, `delete from t`),
// in any file that is neither the table's owner nor listed with it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TABLE_OWNERS } from "../../packages/db/src/owners.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Schema export name to SQL table name, read from the schema's `pgTable("name", ...)` calls. */
export const TABLE_NAMES = new Map(
  [
    ...readFileSync(path.join(ROOT, "packages/db/src/schema.ts"), "utf8").matchAll(
      /export const (\w+) = pgTable\(\s*"(\w+)"/g,
    ),
  ].map(([, name, table]) => [name, table]),
);

const SQL_TABLES = new Set(TABLE_NAMES.values());
const DB_MODULES = new Set(["@open-bot/db", "@open-bot/db/schema"]);
const WRITES = new Set(["insert", "update", "delete"]);
/** SQL that writes a table; `update t set` so a word like "update" in prose isn't one. */
const SQL_WRITE =
  /\b(?:insert\s+into|delete\s+from|update)\s+"?(\w+)"?(?=[\s(]|$)(?:\s+(?:as\s+\w+\s+)?set\b)?/gi;

const covers = (entry, file) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry);

/** The paths allowed to write `table`: its owner, modules sharing columns, and writers moving. */
export function writersOf(table) {
  const owner = TABLE_OWNERS[table];
  if (!owner) return null;
  return [owner.owner, ...(owner.shared ?? []).map((s) => s.by), ...(owner.moving ?? [])];
}

/** Why `file` may not write `table`, or null when it may. */
export function refusal(table, file) {
  const writers = writersOf(table);
  if (!writers) return `\`${table}\` has no owner in packages/db/src/owners.ts. Add one.`;
  if (writers.some((entry) => covers(entry, file))) return null;
  return (
    `Only ${TABLE_OWNERS[table].owner} writes \`${table}\`. Call it instead ` +
    `(see packages/db/src/owners.ts).`
  );
}

/** Tables written by SQL text, with the offset of each write. */
export function sqlWrites(text) {
  const found = [];
  for (const match of text.matchAll(SQL_WRITE)) {
    const table = match[1].toLowerCase();
    const isUpdate = /^update/i.test(match[0]);
    // `update` needs its `set`, so "update the chats" in a comment or message isn't a write.
    if (isUpdate && !/\bset$/i.test(match[0])) continue;
    if (SQL_TABLES.has(table)) found.push({ table, index: match.index });
  }
  return found;
}

/** The schema table a Drizzle argument names, following import aliases, or null. */
function importedTable(context, node) {
  if (node?.type !== "Identifier") return null;
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const def = variable.defs[0];
      if (def?.type !== "ImportBinding") return null;
      const declaration = def.parent;
      if (!DB_MODULES.has(declaration.source.value)) return null;
      const spec = def.node;
      const imported =
        spec.type === "ImportSpecifier" ? (spec.imported.name ?? spec.imported.value) : null;
      return imported ? (TABLE_NAMES.get(imported) ?? null) : null;
    }
    scope = scope.upper;
  }
  return null;
}

/** Calls `found(node, table)` for every table write in the file being linted. */
function visitWrites(context, found) {
  return {
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.computed) return;
      if (!WRITES.has(callee.property.name) || node.arguments.length !== 1) return;
      const table = importedTable(context, node.arguments[0]);
      if (table) found(node, table);
    },
    Literal(node) {
      if (typeof node.value !== "string") return;
      for (const { table } of sqlWrites(node.value)) found(node, table);
    },
    TemplateLiteral(node) {
      const quasis = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
      for (const { table } of sqlWrites(quasis.join(" "))) found(node, table);
      // sql`update ${table} set ...`: the table is interpolated after the write keyword.
      node.expressions.forEach((expression, i) => {
        if (!/\b(?:insert\s+into|delete\s+from|update)\s*"?$/i.test(quasis[i])) return;
        const table = importedTable(context, expression);
        if (table) found(node, table);
      });
    },
  };
}

const fileOf = (context) => path.relative(ROOT, context.filename).split(path.sep).join("/");

export const tableOwnersRule = {
  meta: {
    type: "problem",
    docs: { description: "Only a table's owner (packages/db/src/owners.ts) writes it." },
    schema: [],
  },
  create(context) {
    const file = fileOf(context);
    return visitWrites(context, (node, table) => {
      const message = refusal(table, file);
      if (message) context.report({ node, message });
    });
  },
};

/** Reports every table a file writes, owner or not, with the table as the message (for tests). */
export const tableWritesRule = {
  meta: { type: "problem", docs: { description: "Lists table writes." }, schema: [] },
  create(context) {
    return visitWrites(context, (node, table) => context.report({ node, message: table }));
  },
};

export default { rules: { "table-owners": tableOwnersRule, "table-writes": tableWritesRule } };
