import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");

/** The files TypeScript reads: .ts, .mts and .cts, declaration files included. */
const SOURCE_FILE = /\.[cm]?ts$/;
/**
 * The extensions an import may name for a .ts file: `.ts`, or `.js` as it is spelled when built.
 * Any other (`.mts`, `.mjs`, ...) reaches a different file, so it is kept.
 */
const TS_EXTENSION = /\.(?:ts|js)$/;

/** Every file TypeScript reads under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(file);
    return SOURCE_FILE.test(entry.name) ? [file] : [];
  });
}

/** What an `import(…)` call reaches when its module isn't a plain string, so it can't be checked. */
const COMPUTED = "a computed import(…)";

/**
 * The relative modules `source` (the text of `file`) reaches, resolved to paths: static imports
 * and re-exports, side-effect imports, `import("…")` calls and `import("…")` types. A `.ts` or
 * `.js` extension is dropped, as it names the same file as none. An `import(…)` of anything but a
 * string is `COMPUTED`.
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
      .map((specifier) => path.resolve(path.dirname(file), specifier).replace(TS_EXTENSION, "")),
    ...Array<string>(computed).fill(COMPUTED),
  ];
}

/**
 * The feature folder `target` is in, under `root`'s features folder, if any, and whether it is
 * that feature's index.ts (the folder itself, or `index` with a `.ts` or `.js` extension or none).
 */
function featureOf(root: string, target: string) {
  const relative = path.relative(path.join(root, "features"), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  return { name: name!, index: rest.length === 0 || rest.join("/") === "index" };
}

/**
 * The imports in `file` (under `root`) that reach into a feature it isn't part of, past its
 * index.ts. A computed `import(…)` counts anywhere: what it reaches can't be checked.
 */
function reachesIn(root: string, file: string, source?: string): string[] {
  const home = featureOf(root, file)?.name;
  return imports(file, source)
    .filter((target) => {
      if (target === COMPUTED) return true;
      const feature = featureOf(root, target);
      return feature && feature.name !== home && !feature.index;
    })
    .map((target) =>
      target === COMPUTED
        ? `${path.relative(root, file)}: ${COMPUTED}`
        : `${path.relative(root, file)} -> ${path.relative(root, target)}`,
    );
}

/** Every import under `root` that reaches into a feature past its index.ts. */
function violations(root: string): string[] {
  return files(root).flatMap((file) => reachesIn(root, file));
}

describe("feature folders", () => {
  it("are reached from outside only through their index.ts", () => {
    expect(violations(SOURCE)).toEqual([]);
  });

  it("each have an index.ts", () => {
    const features = path.join(SOURCE, "features");
    for (const entry of readdirSync(features, { withFileTypes: true }))
      if (entry.isDirectory())
        expect(readdirSync(path.join(features, entry.name)), entry.name).toContain("index.ts");
  });

  it("are checked in every file TypeScript reads", () => {
    const root = mkdtempSync(path.join(tmpdir(), "open-bot-boundaries-"));
    try {
      const write = (file: string, source: string) => {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), source);
      };
      const internal = `import { TaskService } from "../features/tasks/service";\n`;
      write("features/tasks/index.ts", `export * from "./service";\n`);
      write("features/tasks/index.mts", `export {};\n`);
      write("features/tasks/service.ts", `export class TaskService {}\n`);
      write(
        "features/pages/load.ts",
        `export const load = (name: string) => import("./" + name);\n`,
      );
      write("runs/module.mts", internal);
      write("runs/common.cts", internal);
      write("runs/types.d.ts", `export { TaskService } from "../features/tasks/service";\n`);
      write("runs/other-index.ts", `import "../features/tasks/index.mjs";\n`);
      write("runs/fine.ts", `import { TaskService } from "../features/tasks";\n`);
      write("runs/notes.md", internal);
      expect(violations(root).sort()).toEqual([
        "features/pages/load.ts: a computed import(…)",
        "runs/common.cts -> features/tasks/service",
        "runs/module.mts -> features/tasks/service",
        "runs/other-index.ts -> features/tasks/index.mjs",
        "runs/types.d.ts -> features/tasks/service",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("are checked for every way of importing", () => {
    const outside = path.join(SOURCE, "runs", "example.ts");
    const inside = path.join(SOURCE, "features", "tasks", "example.ts");
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
      `import { TaskService } from "../features/tasks/index.mjs";`,
      `import { TaskService } from "../features/tasks/index.cts";`,
    ])
      expect(reachesIn(SOURCE, outside, source), source).toHaveLength(1);
    for (const entry of [
      "../features/tasks",
      "../features/tasks/index",
      "../features/tasks/index.ts",
      "../features/tasks/index.js",
    ])
      expect(reachesIn(SOURCE, outside, `import { TaskService } from "${entry}";`), entry).toEqual(
        [],
      );
    expect(reachesIn(SOURCE, inside, `import { TaskService } from "./service";`)).toEqual([]);
  });
});
