import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const SRC = import.meta.dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Whether a file has a `"use server"` directive, at its top or in a function. */
function declaresServerActions(path: string): boolean {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): boolean =>
    (ts.isExpressionStatement(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === "use server") ||
    (ts.forEachChild(node, (child) => visit(child) || undefined) ?? false);
  return visit(file);
}

/**
 * The browser writes through the API (`attempt(api...)`), like the phone, never a server action:
 * Next.js runs those one at a time per tab, and they'd be a second, untyped way in.
 */
it("has no server actions", () => {
  const found = sourceFiles(SRC)
    .filter(declaresServerActions)
    .map((path) => relative(SRC, path));
  expect(found).toEqual([]);
});
