// The `open-bot/table-owners` lint rule: only a table's owner writes it (packages/db/src/owners.ts).
// It reports a Drizzle `.insert(t)`, `.update(t)` or `.delete(t)` whose table `t` is imported from
// @open-bot/db (by name, or through its `schema` object), and SQL text that writes a table
// (`insert into t`, `update t set`, `delete from t`), in any file but the table's owner. A module
// sharing columns may only set those columns.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TABLE_OWNERS } from "../../packages/db/src/owners.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SCHEMA_DIR = path.join(ROOT, "packages/db/src/schema");

/** Schema export name to SQL table name, read from the `pgTable("name", ...)` calls of every schema file. */
export const TABLE_NAMES = new Map(
  readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap((file) => [
      ...readFileSync(path.join(SCHEMA_DIR, file), "utf8").matchAll(
        /export const (\w+) = pgTable\(\s*"(\w+)"/g,
      ),
    ])
    .map(([, name, table]) => [name, table]),
);

const SQL_TABLES = new Set(TABLE_NAMES.values());
const DB_MODULES = new Set(["@open-bot/db", "@open-bot/db/schema"]);
const WRITES = new Set(["insert", "update", "delete"]);
/**
 * A write at the start of a statement (the text's start, or after `;`, `(` or `)`), so prose such
 * as "To delete from pages" isn't one. The table may be schema-qualified and quoted.
 */
const SQL_WRITE =
  /(?:^|[;()])\s*(insert\s+into|delete\s+from|update)\s+(?:"?public"?\s*\.\s*)?"?(\w+)"?/gi;
/** After `update t`: an optional alias, then `set`. */
const UPDATE_SET = /^(?:\s+(?:as\s+)?(?!set\b)"?\w+"?)?\s+set\b/i;

const covers = (entry, file) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry);
const quoted = (names) => names.map((name) => `\`${name}\``).join(", ");

/**
 * Why `file` may not make `write` ({ op, columns }) to `table`, or null when it may. `columns` is
 * null when the columns a write sets can't be read.
 */
export function refusal(table, file, write) {
  const owner = TABLE_OWNERS[table];
  if (!owner) return `\`${table}\` has no owner in packages/db/src/owners.ts. Add one.`;
  if (covers(owner.owner, file)) return null;
  const shared = (owner.shared ?? []).filter((entry) => covers(entry.by, file));
  if (!shared.length)
    return (
      `Only ${owner.owner} writes \`${table}\`. Call it instead ` +
      `(see packages/db/src/owners.ts).`
    );
  const allowed = new Set(shared.flatMap((entry) => entry.columns));
  if (write.op !== "delete" && write.columns?.length && write.columns.every((c) => allowed.has(c)))
    return null;
  return (
    `This file may only set ${quoted([...allowed])} of \`${table}\`, naming each column. ` +
    `Call ${owner.owner} for anything else (see packages/db/src/owners.ts).`
  );
}

/**
 * SQL without comments, and with its string literals emptied, so neither reads as a statement. One
 * pass, so a comment marker inside a literal (or a quote inside a comment) is just text.
 */
function code(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      out += " ";
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else if (text[i] === "'") {
      // Up to the closing quote; `''` inside is an escaped quote.
      let end = i + 1;
      while (end < text.length && !(text[end] === "'" && text[end + 1] !== "'")) {
        end += text[end] === "'" ? 2 : 1;
      }
      // An apostrophe in prose with no closing quote is just a character.
      if (end >= text.length) {
        out += text[i++];
        continue;
      }
      out += "''";
      i = end + 1;
    } else {
      out += text[i++];
    }
  }
  return out;
}

/** The text up to the end of its statement: a `;`, or a `)` closing a parenthesis it didn't open. */
function statement(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth < 0) return text.slice(0, i);
    else if (text[i] === ";" && depth === 0) return text.slice(0, i);
  }
  return text;
}

/** Splits on commas outside parentheses. */
function topLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, text.slice(start)];
}

const column = (text) => /^\s*"?(\w+)"?\s*$/.exec(text)?.[1].toLowerCase() ?? null;

/** Where a clause ends a `set` list: `where`, `from` or `returning` outside parentheses. */
function setListEnd(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && /\w/.test(text[i]) && (i === 0 || !/\w/.test(text[i - 1]))) {
      if (/^(?:where|from|returning)\b/i.test(text.slice(i))) return i;
    }
  }
  return text.length;
}

/** The columns a `set` list assigns, or null when one isn't a plain `column = ...`. */
function setColumns(text) {
  const columns = topLevel(text.slice(0, setListEnd(text))).map((assignment) => {
    const [target] = assignment.split("=");
    return assignment.includes("=") ? column(target) : null;
  });
  return columns.includes(null) ? null : columns;
}

/** The columns an `insert` names, and those its `on conflict ... do update set` assigns. */
function insertColumns(rest) {
  const list = /^\s*\(([^)]*)\)/.exec(rest);
  if (!list) return null;
  const columns = list[1].split(",").map(column);
  const conflict = /\bdo\s+update\s+set\b/i.exec(rest);
  const updates = conflict ? setColumns(rest.slice(conflict.index + conflict[0].length)) : [];
  if (columns.includes(null) || !updates) return null;
  return [...new Set([...columns, ...updates])];
}

/** Tables written by SQL text: `{ table, op, columns }` for each write. */
export function sqlWrites(text) {
  const sql = code(text);
  const found = [];
  for (const match of sql.matchAll(SQL_WRITE)) {
    const table = match[2].toLowerCase();
    if (!SQL_TABLES.has(table)) continue;
    const op = match[1].split(/\s/)[0].toLowerCase();
    const rest = statement(sql.slice(match.index + match[0].length));
    if (op === "update") {
      // `update` needs its `set`, so "update the chats" in a message isn't a write.
      const set = UPDATE_SET.exec(rest);
      if (set) found.push({ table, op, columns: setColumns(rest.slice(set[0].length)) });
    } else {
      found.push({ table, op, columns: op === "insert" ? insertColumns(rest) : null });
    }
  }
  return found;
}

/** The import an identifier is bound to, through scopes and aliases, or null. */
function importOf(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      const def = variable.defs[0];
      if (def?.type !== "ImportBinding" || !DB_MODULES.has(def.parent.source.value)) return null;
      return def.node;
    }
    scope = scope.upper;
  }
  return null;
}

const importedName = (spec) =>
  spec?.type === "ImportSpecifier" ? (spec.imported.name ?? spec.imported.value) : null;

/** Whether `node` is the schema object: `schema` from @open-bot/db, or a namespace import. */
function isSchema(context, node) {
  if (node.type === "Identifier") {
    const spec = importOf(context, node);
    return spec?.type === "ImportNamespaceSpecifier" || importedName(spec) === "schema";
  }
  // `db.schema`, from `import * as db from "@open-bot/db"`.
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.name === "schema" &&
    node.object.type === "Identifier" &&
    importOf(context, node.object)?.type === "ImportNamespaceSpecifier"
  );
}

/** The schema table a Drizzle argument names, or null. */
function importedTable(context, node) {
  if (node?.type === "Identifier")
    return TABLE_NAMES.get(importedName(importOf(context, node))) ?? null;
  if (node?.type === "MemberExpression" && !node.computed && isSchema(context, node.object))
    return TABLE_NAMES.get(node.property.name) ?? null;
  return null;
}

const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The column `sql.identifier(table.column.name)` names, for a schema table, or null. */
function identifiedColumn(context, node) {
  if (node?.type !== "CallExpression" || node.arguments.length !== 1) return null;
  const { callee } = node;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.name !== "identifier"
  )
    return null;
  const name = node.arguments[0];
  if (name.type !== "MemberExpression" || name.computed || name.property.name !== "name")
    return null;
  const column = name.object;
  if (column.type !== "MemberExpression" || column.computed) return null;
  return importedTable(context, column.object) ? snake(column.property.name) : null;
}

/** The columns `.update(t).set({ ... })` assigns, or null when they can't be read. */
function drizzleSetColumns(call) {
  const member = call.parent;
  if (member?.type !== "MemberExpression" || member.property.name !== "set") return null;
  const values = member.parent?.type === "CallExpression" ? member.parent.arguments[0] : null;
  if (values?.type !== "ObjectExpression") return null;
  const keys = values.properties.map((p) =>
    p.type === "Property" && !p.computed ? (p.key.name ?? p.key.value) : null,
  );
  return keys.includes(null) ? null : keys.map(snake);
}

/** Calls `found(node, table, write)` for every table write in the file being linted. */
function visitWrites(context, found) {
  return {
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.computed) return;
      if (!WRITES.has(callee.property.name) || node.arguments.length !== 1) return;
      const table = importedTable(context, node.arguments[0]);
      if (!table) return;
      const op = callee.property.name;
      found(node, table, { op, columns: op === "update" ? drizzleSetColumns(node) : null });
    },
    Literal(node) {
      if (typeof node.value !== "string") return;
      for (const { table, ...write } of sqlWrites(node.value)) found(node, table, write);
    },
    TemplateLiteral(node) {
      // sql`update ${table} set ${sql.identifier(table.column.name)} = ...`: an interpolated table,
      // or a column's name, reads as itself, anything else as a parameter.
      const text = node.quasis
        .map((quasi, i) => {
          const expression = node.expressions[i];
          const name = expression
            ? (importedTable(context, expression) ?? identifiedColumn(context, expression))
            : null;
          const value = expression ? (name ? `"${name}"` : "$0") : "";
          return (quasi.value.cooked ?? quasi.value.raw) + value;
        })
        .join("");
      for (const { table, ...write } of sqlWrites(text)) found(node, table, write);
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
    return visitWrites(context, (node, table, write) => {
      const message = refusal(table, file, write);
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
