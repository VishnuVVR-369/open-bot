import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");

/** The files TypeScript reads, declaration files included. */
const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
/** Extensions an import may name for the same file as none. Any other reaches a different file. */
const TS_EXTENSION = /\.(?:tsx?|jsx?)$/;
const TEST_FILE = /\.test\.tsx?$/;

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
 * A file's module specifiers, its directives, how many `import(…)` calls can't be read, and whether
 * it really imports `server-only` (an import statement, not a comment or a string that says so).
 */
function parse(file: string, source: string) {
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
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  visit(tree);
  const directives = tree.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(ts.isStringLiteral)
    .map((literal) => literal.text);
  const serverOnly = tree.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "server-only",
  );
  return { specifiers, computed, directives, serverOnly };
}

/** A specifier that can only name a folder (`./`, `..`, `server/`), so it reaches the folder's index. */
const FOLDER = /(?:^|\/)\.{0,2}$/;

/**
 * The file TypeScript picks for `target` (a path without an extension): `target.ts` and its kin
 * when one exists, or else the folder's `index`. A spelling that only names a folder skips the file.
 */
function pick(target: string, folder: boolean): string {
  const file = (base: string) => [".ts", ".tsx", ".d.ts"].some((ext) => existsSync(base + ext));
  if (folder || (!file(target) && file(path.join(target, "index"))))
    return path.join(target, "index");
  return target;
}

/**
 * The modules `file` reaches under `root`, as paths without an extension, resolved to the file
 * TypeScript picks: relative imports and the `@/` alias for `root`. An `import(…)` of anything but
 * a string is `COMPUTED`.
 */
function imports(root: string, file: string, source: string): string[] {
  const { specifiers, computed } = parse(file, source);
  const resolve = (specifier: string) => {
    const target = specifier.startsWith("@/")
      ? path.join(root, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : null;
    if (target === null) return null;
    if (TS_EXTENSION.test(specifier)) return target.replace(TS_EXTENSION, "");
    return pick(path.resolve(target), FOLDER.test(specifier));
  };
  return [
    ...specifiers.map(resolve).filter((target) => target !== null),
    ...Array<string>(computed).fill(COMPUTED),
  ];
}

/**
 * Where `target` is among `root`'s features: which feature, whether it is one of its two entries
 * (`index.ts`, the client side, or `server.ts`), and whether it is server code (`server.ts` or
 * anything under `server/`).
 */
function featureOf(root: string, target: string) {
  const relative = path.relative(path.join(root, "features"), target.replace(TS_EXTENSION, ""));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  if (!name || (rest.length === 0 && name.includes("."))) return null;
  const entry =
    rest.length === 0 || rest.join("/") === "index"
      ? "index"
      : rest.join("/") === "server"
        ? "server"
        : null;
  return { name, entry, server: rest[0] === "server" };
}

/** What `file` (under `root`) does that the feature boundaries don't allow, one line each. */
function problems(root: string, file: string, source = readFileSync(file, "utf8")): string[] {
  const at = path.relative(root, file);
  const home = featureOf(root, file);
  const { directives, serverOnly } = parse(file, source);
  const client = directives.includes("use client");
  const found: string[] = [];
  for (const target of imports(root, file, source)) {
    if (target === COMPUTED) {
      found.push(`${at}: ${COMPUTED}`);
      continue;
    }
    const feature = featureOf(root, target);
    if (!feature) continue;
    const to = path.relative(root, target);
    if (feature.name !== home?.name && !feature.entry)
      found.push(`${at} -> ${to}: past its entries`);
    else if (feature.server && (client || (home?.name === feature.name && !home.server)))
      found.push(`${at} -> ${to}: client code importing server code`);
  }
  if (home?.server && !TEST_FILE.test(file) && !serverOnly)
    found.push(`${at}: server code without import "server-only"`);
  return found;
}

/** Every problem with the feature boundaries under `root`. */
function violations(root: string): string[] {
  return files(root).flatMap((file) => problems(root, file));
}

describe("feature folders", () => {
  it("keep their boundaries", () => {
    expect(violations(SOURCE)).toEqual([]);
  });

  it("each have an index.ts", () => {
    const features = path.join(SOURCE, "features");
    for (const entry of readdirSync(features, { withFileTypes: true }))
      if (entry.isDirectory())
        expect(readdirSync(path.join(features, entry.name)), entry.name).toContain("index.ts");
  });

  it("are checked in every file TypeScript reads", () => {
    const root = mkdtempSync(path.join(tmpdir(), "open-bot-web-boundaries-"));
    try {
      const write = (file: string, source: string) => {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), source);
      };
      const server = `import "server-only";\nexport const listTasks = () => [];\n`;
      write("features/tasks/index.ts", `export { TaskBoard } from "./components/board";\n`);
      write(
        "features/tasks/server.ts",
        `import "server-only";\nexport * from "./server/queries";\n`,
      );
      write("features/tasks/server/queries.ts", server);
      write(
        "features/tasks/server/routes.ts",
        `// import "server-only";\nexport const routes = {};\n`,
      );
      write("features/tasks/server/jobs.ts", `import 'server-only';\nexport const jobs = [];\n`);
      write("features/tasks/server/types.ts", `import type {} from "server-only";\nexport {};\n`);
      write("features/notes/index.ts", `export {};\n`);
      write("features/notes/server/index.ts", server);
      write("features/tasks/server/queries.test.ts", `export {};\n`);
      write("features/tasks/components/board.tsx", `import { listTasks } from "../server";\n`);
      write(
        "features/pages/load.ts",
        `export const load = (name: string) => import("./" + name);\n`,
      );
      write("app/tasks/page.tsx", `import { TaskBoard } from "@/features/tasks";\n`);
      write("app/tasks/data.ts", `import { listTasks } from "@/features/tasks/server";\n`);
      write(
        "app/tasks/view.tsx",
        `"use client";\nimport { listTasks } from "@/features/tasks/server";\n`,
      );
      write("lib/router.ts", `import { listTasks } from "../features/tasks/server/queries";\n`);
      write("lib/types.d.ts", `export type { Board } from "@/features/tasks/components/board";\n`);
      write("lib/folder.ts", `import { listTasks } from "@/features/tasks/server/";\n`);
      write("lib/notes.ts", `import { listNotes } from "@/features/notes/server";\n`);
      write("lib/notes.md", `import { listTasks } from "@/features/tasks/server/queries";\n`);
      expect(violations(root).sort()).toEqual([
        "app/tasks/view.tsx -> features/tasks/server: client code importing server code",
        "features/pages/load.ts: a computed import(…)",
        "features/tasks/components/board.tsx -> features/tasks/server: client code importing server code",
        'features/tasks/server/routes.ts: server code without import "server-only"',
        'features/tasks/server/types.ts: server code without import "server-only"',
        "lib/folder.ts -> features/tasks/server/index: past its entries",
        "lib/notes.ts -> features/notes/server/index: past its entries",
        "lib/router.ts -> features/tasks/server/queries: past its entries",
        "lib/types.d.ts -> features/tasks/components/board: past its entries",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("are checked for every way of importing", () => {
    const outside = path.join(SOURCE, "lib", "example.ts");
    for (const internal of ["@/features/tasks/server/queries", "../features/tasks/server/queries"])
      for (const source of [
        `import { listTasks } from "${internal}";`,
        `import { listTasks } from "${internal}.ts";`,
        `import type { TaskView } from "${internal}";`,
        `export { listTasks } from "${internal}";`,
        `export * from "${internal}";`,
        `import "${internal}";`,
        `const { listTasks } = await import("${internal}");`,
        `type Tasks = import("${internal}").Tasks;`,
      ])
        expect(problems(SOURCE, outside, source), source).toHaveLength(1);
    for (const folder of [
      "@/features/tasks/server/",
      "../features/tasks/server/",
      "../features/tasks/server/.",
    ])
      expect(problems(SOURCE, outside, `import { x } from "${folder}";`), folder).toHaveLength(1);
    for (const entry of [
      "@/features/tasks",
      "@/features/tasks/index",
      "@/features/tasks/index.ts",
      "@/features/tasks/server",
      "../features/tasks",
      "../features/tasks/server.ts",
    ])
      expect(problems(SOURCE, outside, `import { x } from "${entry}";`), entry).toEqual([]);
  });
});
