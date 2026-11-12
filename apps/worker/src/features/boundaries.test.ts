import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");
const FEATURES = path.join(SOURCE, "features");

/** Every TypeScript file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(file);
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/**
 * The relative modules `source` (the text of `file`) reaches, resolved to paths without an
 * extension: static imports and re-exports, side-effect imports, `import("…")` calls and
 * `import("…")` types.
 */
function imports(file: string, source = readFileSync(file, "utf8")): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  return specifiers
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => path.resolve(path.dirname(file), specifier));
}

/** The feature folder `target` is in, if any, and whether it is that feature's index.ts. */
function featureOf(target: string) {
  const relative = path.relative(FEATURES, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  return { name: name!, index: rest.length === 0 || rest.join("/") === "index" };
}

/** The imports in `file` that reach into a feature it isn't part of, past its index.ts. */
function reachesIn(file: string, source?: string): string[] {
  const home = featureOf(file)?.name;
  return imports(file, source)
    .filter((target) => {
      const feature = featureOf(target);
      return feature && feature.name !== home && !feature.index;
    })
    .map((target) => `${path.relative(SOURCE, file)} -> ${path.relative(SOURCE, target)}`);
}

describe("feature folders", () => {
  it("are reached from outside only through their index.ts", () => {
    expect(files(SOURCE).flatMap((file) => reachesIn(file))).toEqual([]);
  });

  it("each have an index.ts", () => {
    for (const entry of readdirSync(FEATURES, { withFileTypes: true }))
      if (entry.isDirectory())
        expect(readdirSync(path.join(FEATURES, entry.name)), entry.name).toContain("index.ts");
  });

  it("are checked for every way of importing", () => {
    const outside = path.join(SOURCE, "runs", "example.ts");
    const inside = path.join(FEATURES, "tasks", "example.ts");
    const internal = "../features/tasks/service";
    for (const source of [
      `import { TaskService } from "${internal}";`,
      `import type { TaskService } from "${internal}";`,
      `import {\n  TaskService,\n} from "${internal}";`,
      `export { TaskService } from "${internal}";`,
      `export * from "${internal}";`,
      `import "${internal}";`,
      `const { TaskService } = await import("${internal}");`,
      `type Service = import("${internal}").TaskService;`,
    ])
      expect(reachesIn(outside, source), source).toHaveLength(1);
    expect(reachesIn(outside, `import { TaskService } from "../features/tasks";`)).toEqual([]);
    expect(reachesIn(inside, `import { TaskService } from "./service";`)).toEqual([]);
  });
});
