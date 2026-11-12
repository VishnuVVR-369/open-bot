// The repository's import graph, file to file, built the way the type checker sees it: every
// `import`, `import type`, `export ... from`, `import()` and `require()` in a workspace's code,
// resolved with that workspace's own tsconfig (its `paths`, `customConditions` and package
// `exports`), so `@/lib/x` and `@open-bot/domain` land on the files they mean. It reads each file
// once and parses no types, so the whole repository takes about a second.
// Used by scripts/check/imports.mjs. Needs only git, Node and the root `typescript`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Where code lives: each folder here is one workspace. */
export const WORKSPACE_ROOTS = ["apps", "packages", "tools"];
/** Code outside a workspace folder that still imports workspace code. */
export const OTHER_CODE = ["e2e"];

export const CODE = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/** Generated or vendored code: never edited by hand, so never part of a fix. */
export const GENERATED = [
  /^packages\/agent\/src\/protocol\//,
  /^apps\/mobile\/src\/computer\/viewer-html\.ts$/,
  /^apps\/web\/src\/components\/ui\//, // shadcn.
  /\/drizzle\//,
  /(^|\/)(dist|build|out|release|\.next[^/]*|\.expo|android|ios)\//,
  /(^|\/)next-env\.d\.ts$/,
];

/** Tracked and untracked, not ignored, code files under `folders`, minus generated code. */
export function codeFiles(root, folders, exclude = GENERATED) {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      // A plain pathspec's `*` also matches "/", so `apps/*.ts` is every .ts file under apps.
      ...folders.flatMap((folder) => CODE.map((glob) => `${folder}/${glob}`)),
    ],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(out.split("\0"))]
    .filter((file) => file && !exclude.some((pattern) => pattern.test(file)))
    .filter((file) => existsSync(path.join(root, file)))
    .sort();
}

/** `apps/web` for `apps/web/src/x.ts`, `e2e` for `e2e/x.ts`, null for anything else. */
export function workspaceOf(file) {
  const [top, name] = file.split("/");
  if (WORKSPACE_ROOTS.includes(top) && name) return `${top}/${name}`;
  if (OTHER_CODE.includes(top)) return top;
  return null;
}

export const isApp = (workspace) => workspace?.startsWith("apps/") ?? false;

/** The nearest tsconfig.json at or above the file's folder, inside its workspace. */
function tsconfigFor(root, file) {
  const stop = workspaceOf(file);
  let dir = path.posix.dirname(file);
  for (;;) {
    if (existsSync(path.join(root, dir, "tsconfig.json"))) return `${dir}/tsconfig.json`;
    if (dir === stop || dir === "." || !dir.includes("/")) return null;
    dir = path.posix.dirname(dir);
  }
}

/** Compiler options for resolving imports only: JavaScript files are modules too. */
function resolutionOptions(root, config) {
  const fallback = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (!config) return { ...fallback, allowJs: true };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(root, config),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  return { ...(parsed?.options ?? fallback), allowJs: true, noEmit: true };
}

/** Line (1-based) of character offset `pos`. */
function lineAt(text, pos) {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * `{ files, edges }`: `edges` maps each file to the files it imports, as
 * `Map<target, { specifier, line }>` (the first import of that target). Imports of packages from
 * node_modules, of generated code and of non-code files are left out.
 */
export function buildGraph(givenRoot, { folders = [...WORKSPACE_ROOTS, ...OTHER_CODE] } = {}) {
  // TypeScript resolves to real paths, so everything is relative to the real root.
  const root = realpathSync(givenRoot);
  const files = codeFiles(root, folders);
  const known = new Set(files);
  const options = new Map();
  const caches = new Map();
  const edges = new Map();

  for (const file of files) {
    const config = tsconfigFor(root, file);
    if (!options.has(config)) {
      const opts = resolutionOptions(root, config);
      options.set(config, opts);
      caches.set(
        config,
        ts.createModuleResolutionCache(root, (name) => name, opts),
      );
    }
    const text = readFileSync(path.join(root, file), "utf8");
    const { importedFiles } = ts.preProcessFile(text, true, true);
    const out = new Map();
    for (const { fileName: specifier, pos } of importedFiles) {
      const { resolvedModule } = ts.resolveModuleName(
        specifier,
        path.join(root, file),
        options.get(config),
        ts.sys,
        caches.get(config),
      );
      if (!resolvedModule) continue;
      const target = path.relative(root, resolvedModule.resolvedFileName).split(path.sep).join("/");
      if (!known.has(target) || target === file || out.has(target)) continue;
      out.set(target, { specifier, line: lineAt(text, pos) });
    }
    edges.set(file, out);
  }
  return { files, edges };
}

/** Strongly connected components with more than one file (Tarjan's algorithm, iterative). */
export function cycleGroups(edges) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    const work = [[start, [...(edges.get(start)?.keys() ?? [])], 0]];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work.at(-1);
      const [node, targets] = frame;
      if (frame[2] < targets.length) {
        const target = targets[frame[2]++];
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next++);
          stack.push(target);
          onStack.add(target);
          work.push([target, [...(edges.get(target)?.keys() ?? [])], 0]);
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work.at(-1)[0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const group = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          group.push(member);
        } while (member !== node);
        if (group.length > 1) groups.push(group.sort());
      }
    }
  }
  return groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** The shortest import path from `from` to `to`, as a list of files, or null. */
export function importPath(edges, from, to) {
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const node = queue.shift();
    if (node === to) {
      const out = [];
      for (let at = to; at !== null; at = previous.get(at)) out.unshift(at);
      return out;
    }
    for (const target of edges.get(node)?.keys() ?? []) {
      if (!previous.has(target)) {
        previous.set(target, node);
        queue.push(target);
      }
    }
  }
  return null;
}
