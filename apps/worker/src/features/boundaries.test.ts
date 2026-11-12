import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");
const FEATURES = path.join(SOURCE, "features");

/** The source extensions TypeScript compiles, and the ones an import may name instead. */
const SOURCE_FILE = /\.[cm]?ts$/;
const MODULE_EXTENSION = /\.(?:[cm]?ts|[cm]?js)$/;

/** Every TypeScript file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(file);
    return SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

/** What an `import(…)` call reaches when its module isn't a plain string, so it can't be checked. */
const COMPUTED = "a computed import(…)";

/**
 * The relative modules `source` (the text of `file`) reaches, resolved to paths without an
 * extension: static imports and re-exports, side-effect imports, `import("…")` calls and
 * `import("…")` types. An `import(…)` of anything but a string is `COMPUTED`.
 */
function imports(file: string, source = readFileSync(file, "utf8")): string[] {
  const specifiers: string[] = [];
  let computed = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [module] = node.arguments;
      if (module && ts.isStringLiteralLike(module)) specifiers.push(module.text);
      else computed++;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  return [
    ...specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) =>
        path.resolve(path.dirname(file), specifier).replace(MODULE_EXTENSION, ""),
      ),
    ...Array<string>(computed).fill(COMPUTED),
  ];
}

/** The feature folder `target` is in, if any, and whether it is that feature's index.ts. */
function featureOf(target: string) {
  const relative = path.relative(FEATURES, target.replace(MODULE_EXTENSION, ""));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  return { name: name!, index: rest.length === 0 || rest.join("/") === "index" };
}

/**
 * The imports in `file` that reach into a feature it isn't part of, past its index.ts. A computed
 * `import(…)` counts anywhere: what it reaches can't be checked.
 */
function reachesIn(file: string, source?: string): string[] {
  const home = featureOf(file)?.name;
  return imports(file, source)
    .filter((target) => {
      if (target === COMPUTED) return true;
      const feature = featureOf(target);
      return feature && feature.name !== home && !feature.index;
    })
    .map((target) =>
      target === COMPUTED
        ? `${path.relative(SOURCE, file)}: ${COMPUTED}`
        : `${path.relative(SOURCE, file)} -> ${path.relative(SOURCE, target)}`,
    );
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

  it("are checked in every kind of source file", () => {
    const found = files(SOURCE).map((file) => path.relative(SOURCE, file));
    expect(found).toContain("features/boundaries.test.ts");
    for (const name of ["a.ts", "a.mts", "a.cts"]) expect(SOURCE_FILE.test(name), name).toBe(true);
  });

  it("are checked for every way of importing", () => {
    const outside = path.join(SOURCE, "runs", "example.ts");
    const inside = path.join(FEATURES, "tasks", "example.ts");
    const internal = "../features/tasks/service";
    for (const source of [
      `import { TaskService } from "${internal}";`,
      `import { TaskService } from "${internal}.js";`,
      `import type { TaskService } from "${internal}";`,
      `import {\n  TaskService,\n} from "${internal}";`,
      `export { TaskService } from "${internal}";`,
      `export * from "${internal}";`,
      `import "${internal}";`,
      `const { TaskService } = await import("${internal}");`,
      `const { TaskService } = await import("../features/tasks/" + "service");`,
      `type Service = import("${internal}").TaskService;`,
    ])
      expect(reachesIn(outside, source), source).toHaveLength(1);
    for (const entry of [
      "../features/tasks",
      "../features/tasks/index.ts",
      "../features/tasks/index.js",
    ])
      expect(reachesIn(outside, `import { TaskService } from "${entry}";`), entry).toEqual([]);
    expect(reachesIn(inside, `import { TaskService } from "./service";`)).toEqual([]);
  });
});
