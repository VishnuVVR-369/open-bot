// The `open-bot/workspace-imports` lint rule: workspace code is imported only through the
// package's name and its package.json `exports`, so each package decides what it exposes and can
// move its files freely. It reports, in imports, re-exports, `import()` and `require()`:
//
// - `@open-bot/<package>/<path>` where `./<path>` is not in that package's `exports`;
// - `@open-bot/<app>`: apps (apps/*, tools/*) export nothing;
// - a relative path into another package (`../packages/db/src/index`).
//
// A relative path into another app is the other boundary, "an app never imports another app",
// which scripts/check/imports.mjs checks with a baseline because old tests still do it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Each workspace's folder, `exports` entry points (`.`, `./server`) and whether it is a library. */
function readWorkspaces(root) {
  const out = new Map();
  for (const top of ["apps", "packages", "tools"]) {
    if (!existsSync(path.join(root, top))) continue;
    for (const name of readdirSync(path.join(root, top))) {
      const manifest = path.join(root, top, name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      const exports = pkg.exports;
      const entries =
        typeof exports === "string" || (exports && !Object.keys(exports)[0]?.startsWith("."))
          ? ["."]
          : Object.keys(exports ?? {});
      out.set(pkg.name, { folder: `${top}/${name}`, entries, library: top === "packages" });
    }
  }
  return out;
}

export const WORKSPACES = readWorkspaces(ROOT);
const BY_FOLDER = new Map([...WORKSPACES.values()].map((ws) => [ws.folder, ws]));

/** `./server` matches `./server`; `./icons/*` matches `./icons/x`. */
function exported(entries, subpath) {
  return entries.some((entry) => {
    const star = entry.indexOf("*");
    if (star === -1) return entry === subpath;
    return subpath.startsWith(entry.slice(0, star)) && subpath.endsWith(entry.slice(star + 1));
  });
}

/** `packages/db` for `packages/db/src/x.ts`, or the top folder (`e2e`) outside a workspace. */
function folderOf(file) {
  const [top, name] = file.split("/");
  return BY_FOLDER.has(`${top}/${name}`) ? `${top}/${name}` : top;
}

/** Why `file` (repo-relative) may not import `source`, or null when it may. */
export function refusal(file, source) {
  const bare = /^(@open-bot\/[^/]+)(\/.*)?$/.exec(source);
  if (bare) {
    const [, name, rest] = bare;
    const ws = WORKSPACES.get(name);
    if (!ws || folderOf(file) === ws.folder) return null;
    if (!ws.library) {
      return `${name} is an app (${ws.folder}), and apps export no code. Move what you need into a package under packages/ and import that.`;
    }
    const subpath = `.${rest ?? ""}`;
    if (exported(ws.entries, subpath)) return null;
    const allowed = ws.entries.map((entry) => `${name}${entry.slice(1)}`).join(", ");
    return `"${source}" is not an entry point of ${name}. Import ${allowed}, or add "${subpath}" to "exports" in ${ws.folder}/package.json if it is meant to be public.`;
  }
  if (!source.startsWith(".")) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
  const into = folderOf(target);
  const ws = BY_FOLDER.get(into);
  if (!ws?.library || into === folderOf(file)) return null;
  const name = [...WORKSPACES].find(([, value]) => value === ws)[0];
  return `"${source}" reaches into ${into} by path. Import ${name} (an entry point in its package.json "exports") and list it in this workspace's package.json dependencies.`;
}

const fileOf = (context) => path.relative(ROOT, context.filename).split(path.sep).join("/");

export const workspaceImportsRule = {
  meta: {
    type: "problem",
    docs: { description: "Workspace code is imported through its package name and exports." },
    schema: [],
  },
  create(context) {
    const file = fileOf(context);
    const check = (node) => {
      if (node?.type !== "Literal" || typeof node.value !== "string") return;
      const message = refusal(file, node.value);
      if (message) context.report({ node, message });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportEqualsDeclaration: (node) => check(node.moduleReference?.expression),
      TSImportType: (node) => check(node.argument?.literal ?? node.argument),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          check(node.arguments[0]);
        }
      },
    };
  },
};

export default { rules: { "workspace-imports": workspaceImportsRule } };
