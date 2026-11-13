import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");
const TSCONFIG = path.join(SOURCE, "..", "tsconfig.json");

/** The files TypeScript reads (the app sets `allowJs`), declaration files included. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Every file TypeScript reads under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(file);
    return SOURCE_FILE.test(entry.name) ? [file] : [];
  });
}

/** The app's compiler options, with the `@/` alias pointing at `root` as it points at `src`. */
function compilerOptions(root: string): ts.CompilerOptions {
  const { options, errors } = ts.parseJsonConfigFileContent(
    { extends: TSCONFIG, compilerOptions: { paths: { "@/*": ["./*"] } } },
    ts.sys,
    root,
  );
  if (errors.length > 0)
    throw new Error(ts.flattenDiagnosticMessageText(errors[0]?.messageText, "\n"));
  return options;
}

/** How TypeScript parses `file`, by its extension: JSX only in `.tsx` and JavaScript files. */
function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** One module a file reaches, and whether TypeScript erases the import (so it never runs). */
type Edge = { specifier: string; typeOnly: boolean };
/** What an `import(…)` or `require(…)` reaches when its module isn't a plain string. */
const COMPUTED = "a computed import(…) or require(…)";

/**
 * A file's imports, its directives, whether it really imports `server-only` (an import statement,
 * not a comment or a string that says so), and the first syntax error, which could hide imports.
 * Under `verbatimModuleSyntax` only a whole `import type` is erased, never `import { type X }`.
 */
function parse(file: string, source: string) {
  const edges: (Edge | typeof COMPUTED)[] = [];
  const module = (node: ts.Expression | undefined, typeOnly: boolean) => {
    if (node && ts.isStringLiteralLike(node)) edges.push({ specifier: node.text, typeOnly });
    else edges.push(COMPUTED);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) module(node.moduleSpecifier, !!node.importClause?.isTypeOnly);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      module(node.moduleSpecifier, node.isTypeOnly);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      module(node.moduleReference.expression, node.isTypeOnly);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      module(node.arguments[0], false);
    else if (ts.isImportTypeNode(node))
      module(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
    ts.forEachChild(node, visit);
  };
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
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
  // Not in TypeScript's public types, but always set; without it, a file that doesn't parse
  // could hide the imports after the error.
  const { parseDiagnostics } = tree as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] };
  if (!parseDiagnostics) throw new Error("TypeScript no longer reports parse errors this way.");
  const [error] = parseDiagnostics;
  const syntaxError = error && ts.flattenDiagnosticMessageText(error.messageText, " ");
  return { edges, directives, serverOnly, syntaxError };
}

/**
 * The file an import in `file` reaches, as TypeScript resolves it with the app's options (`@/`,
 * folders, `index`, `package.json`, `.js`), or as a plain path for files it doesn't resolve, such
 * as stylesheets. `undefined` for a package; `null` for a path that reaches no file.
 */
function resolve(root: string, options: ts.CompilerOptions, file: string, specifier: string) {
  const local =
    specifier.startsWith("@/") || specifier.startsWith(".") || path.isAbsolute(specifier);
  if (!local) return undefined;
  const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
  if (resolved) return resolved.resolvedFileName;
  const target = specifier.startsWith("@/")
    ? path.join(root, specifier.slice(2))
    : path.resolve(path.dirname(file), specifier);
  try {
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

/**
 * Where `file` is among `root`'s features: which feature, whether it is one of its two entries
 * (`index.ts`, the client side, or `server.ts`), and whether it is server code (`server.ts` or
 * anything under `server/`).
 */
function featureOf(root: string, file: string) {
  const relative = path.relative(path.join(root, "features"), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  // A file right in features/, such as this test, belongs to no feature.
  if (!name || rest.length === 0) return null;
  const inside = rest.join("/");
  const entry = inside === "index.ts" ? "index" : inside === "server.ts" ? "server" : null;
  return { name, entry, server: rest[0] === "server" || inside === "server.ts" };
}

/** What `file` (under `root`) does that the feature boundaries don't allow, one line each. */
function problems(
  root: string,
  file: string,
  source = readFileSync(file, "utf8"),
  options = compilerOptions(root),
): string[] {
  const at = path.relative(root, file);
  const home = featureOf(root, file);
  const { edges, directives, serverOnly, syntaxError } = parse(file, source);
  const client = directives.includes("use client");
  const found: string[] = [];
  if (syntaxError) found.push(`${at}: doesn't parse (${syntaxError})`);
  for (const edge of edges) {
    if (edge === COMPUTED) {
      found.push(`${at}: ${COMPUTED}`);
      continue;
    }
    const target = resolve(root, options, file, edge.specifier);
    if (target === undefined) continue;
    if (target === null) {
      found.push(`${at} -> ${edge.specifier}: reaches no file`);
      continue;
    }
    const feature = featureOf(root, target);
    if (!feature) continue;
    const to = path.relative(root, target);
    if (feature.name !== home?.name && !feature.entry)
      found.push(`${at} -> ${to}: past its entries`);
    // An erased import puts no server code in the browser.
    else if (
      !edge.typeOnly &&
      feature.server &&
      (client || (home?.name === feature.name && !home.server))
    )
      found.push(`${at} -> ${to}: client code importing server code`);
  }
  if (home?.server && !TEST_FILE.test(file) && !serverOnly)
    found.push(`${at}: server code without import "server-only"`);
  return found;
}

/** Packages that only run on the server: the database and the server entries of workspace packages. */
const SERVER_PACKAGE = /^(@open-bot\/db|@open-bot\/[\w-]+\/server|pg)(\/|$)/;

/**
 * Server code a feature's client entry (`index.ts`) reaches through the imports that run, one line
 * each. A client component that imports the entry would bundle it for the browser, where it fails.
 */
function clientReach(root: string, options: ts.CompilerOptions): string[] {
  const found: string[] = [];
  const entries = files(path.join(root, "features")).filter(
    (file) => featureOf(root, file)?.entry === "index",
  );
  for (const entry of entries) {
    const seen = new Set([entry]);
    const queue = [entry];
    for (let file = queue.shift(); file; file = queue.shift()) {
      const { edges, serverOnly } = parse(file, readFileSync(file, "utf8"));
      const server = serverOnly
        ? "server-only"
        : edges.find(
            (edge): edge is Edge =>
              edge !== COMPUTED && !edge.typeOnly && SERVER_PACKAGE.test(edge.specifier),
          )?.specifier;
      if (server) {
        found.push(
          `${path.relative(root, entry)} reaches ${path.relative(root, file)}, which imports ${server}`,
        );
        continue;
      }
      for (const edge of edges) {
        if (edge === COMPUTED || edge.typeOnly) continue;
        const target = resolve(root, options, file, edge.specifier);
        if (target && SOURCE_FILE.test(target) && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return found;
}

/** Every problem with the feature boundaries under `root`. */
function violations(root: string): string[] {
  const options = compilerOptions(root);
  return [
    ...files(root).flatMap((file) => problems(root, file, undefined, options)),
    ...clientReach(root, options),
  ];
}

describe("feature folders", () => {
  // It parses and resolves every file in the app, like a lint pass: about 0.3s alone, but several
  // seconds on a CI runner busy with every package's tests at once.
  it("keep their boundaries", () => {
    expect(violations(SOURCE)).toEqual([]);
  }, 30_000);

  it("each have an index.ts", () => {
    const features = path.join(SOURCE, "features");
    for (const entry of readdirSync(features, { withFileTypes: true }))
      if (entry.isDirectory())
        expect(readdirSync(path.join(features, entry.name)), entry.name).toContain("index.ts");
  });

  it("are checked in every file TypeScript reads", () => {
    // The resolver answers with real paths, and the temporary folder may be behind a symlink.
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "open-bot-web-boundaries-")));
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
      write("features/tasks/server.ts.ts", `export {};\n`);
      write("features/tasks/server/queries.ts", server);
      write(
        "features/tasks/server/routes.ts",
        `// import "server-only";\nexport const routes = {};\n`,
      );
      write("features/tasks/server/jobs.ts", `import 'server-only';\nexport const jobs = [];\n`);
      write("features/tasks/server/types.ts", `import type {} from "server-only";\nexport {};\n`);
      write("features/tasks/server/queries.test.ts", `export {};\n`);
      write("features/tasks/components/board.tsx", `import { listTasks } from "../server";\n`);
      write(
        "features/tasks/components/types.ts",
        `import type { listTasks } from "../server";\nexport type Tasks = typeof listTasks;\n`,
      );
      write("features/notes/index.ts", `export { Note } from "./components/note";\n`);
      write(
        "features/notes/components/note.tsx",
        `import { revision } from "@open-bot/db";\nexport const Note = () => revision;\n`,
      );
      write("features/notes/server/index.js", server);
      write(
        "features/docs/index.ts",
        `import type { Db } from "@open-bot/db";\nimport type {} from "./server/queries";\nexport type { Db };\n`,
      );
      write("features/docs/server/package.json", `{ "types": "queries.ts" }\n`);
      write("features/docs/server/queries.ts", server);
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
      write(
        "app/tasks/types.tsx",
        `"use client";\nimport type { listTasks } from "@/features/tasks/server";\n`,
      );
      write(
        "app/tasks/kept.tsx",
        `"use client";\nimport { type listTasks } from "@/features/tasks/server";\n`,
      );
      write("lib/router.ts", `import { listTasks } from "../features/tasks/server/queries";\n`);
      write("lib/types.d.ts", `export type { Board } from "@/features/tasks/components/board";\n`);
      write("lib/folder.ts", `import { listTasks } from "@/features/tasks/server/";\n`);
      write("lib/notes.js", `import { listNotes } from "@/features/notes/server";\n`);
      write("lib/docs.ts", `import { listDocs } from "@/features/docs/server";\n`);
      write("lib/twice.ts", `import { x } from "@/features/tasks/server.ts.ts";\n`);
      write(
        "lib/generic.ts",
        `export const same = <T>(x: T): T => x;\nimport { listTasks } from "@/features/tasks/server/jobs";\n`,
      );
      write("lib/broken.ts", `export const = ;\n`);
      write("lib/notes.md", `import { listTasks } from "@/features/tasks/server/queries";\n`);
      expect(violations(root).sort()).toEqual([
        "app/tasks/kept.tsx -> features/tasks/server.ts: client code importing server code",
        "app/tasks/view.tsx -> features/tasks/server.ts: client code importing server code",
        "features/notes/index.ts reaches features/notes/components/note.tsx, which imports @open-bot/db",
        "features/pages/load.ts: a computed import(…) or require(…)",
        "features/tasks/components/board.tsx -> features/tasks/server.ts: client code importing server code",
        "features/tasks/index.ts reaches features/tasks/server.ts, which imports server-only",
        'features/tasks/server/routes.ts: server code without import "server-only"',
        'features/tasks/server/types.ts: server code without import "server-only"',
        expect.stringMatching(/^lib\/broken\.ts: doesn't parse/),
        "lib/docs.ts -> features/docs/server/queries.ts: past its entries",
        "lib/folder.ts -> @/features/tasks/server/: reaches no file",
        "lib/generic.ts -> features/tasks/server/jobs.ts: past its entries",
        "lib/notes.js -> features/notes/server/index.js: past its entries",
        "lib/router.ts -> features/tasks/server/queries.ts: past its entries",
        "lib/twice.ts -> features/tasks/server.ts.ts: past its entries",
        "lib/types.d.ts -> features/tasks/components/board.tsx: past its entries",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("are checked for every way of importing", () => {
    const outside = path.join(SOURCE, "lib", "example.ts");
    const options = compilerOptions(SOURCE);
    const check = (source: string) => problems(SOURCE, outside, source, options);
    for (const internal of [
      "@/features/tasks/server/queries",
      "../features/tasks/server/queries",
      path.join(SOURCE, "features/tasks/server/queries"),
    ])
      for (const source of [
        `import { listTasks } from "${internal}";`,
        `import { listTasks } from "${internal}.ts";`,
        `import type { TaskView } from "${internal}";`,
        `export { listTasks } from "${internal}";`,
        `export * from "${internal}";`,
        `import "${internal}";`,
        `const { listTasks } = await import("${internal}");`,
        `type Tasks = import("${internal}").Tasks;`,
        `const { listTasks } = require("${internal}");`,
        `import type Queries = require("${internal}");`,
      ])
        expect(check(source), source).toHaveLength(1);
    for (const folder of [
      "@/features/tasks/server/",
      "../features/tasks/server/",
      "../features/tasks/server/.",
    ])
      expect(check(`import { x } from "${folder}";`), folder).toHaveLength(1);
    for (const entry of [
      "@/features/tasks",
      "@/features/tasks/index",
      "@/features/tasks/index.ts",
      "@/features/tasks/server",
      "../features/tasks",
      "../features/tasks/server.ts",
    ])
      expect(check(`import { x } from "${entry}";`), entry).toEqual([]);
  });
});
