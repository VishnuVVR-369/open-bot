#!/usr/bin/env node
// Keeps shared dependency versions in one place: the default pnpm catalog in pnpm-workspace.yaml.
// Fails when a dependency that two or more workspaces declare (the root included) is declared by
// any of them with a version instead of `catalog:`, and when a catalog entry no workspace uses.
// Fix the first by adding the dependency to `catalog:` and declaring `"name": "catalog:"` in every
// workspace that uses it; the second by deleting the entry. `workspace:` dependencies and peer
// dependencies are not counted. pnpm's own `catalogMode: strict` is not used: on `pnpm add` it
// rewrites pnpm-workspace.yaml (dropping comments, pinning ranges) and moves every new dependency
// into the catalog, and it never checks a hand-edited package.json. Needs only Node.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** The workspace globs and default catalog entry names from pnpm-workspace.yaml. */
export function parseWorkspace(yaml) {
  const globs = [];
  const catalog = [];
  let section = null;
  for (const line of yaml.split("\n")) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) {
      section = line.replace(/\s+#.*/, "").trim();
      continue;
    }
    if (section === "packages:") {
      const glob = line.match(/^\s+-\s+["']?([^"'\s#]+)["']?/)?.[1];
      if (glob) globs.push(glob);
    } else if (section === "catalog:") {
      const name = line.match(/^ {2}["']?([^"'\s:#][^"':]*)["']?\s*:/)?.[1];
      if (name) catalog.push(name);
    }
  }
  return { globs, catalog };
}

/** Every workspace folder (relative to root): the root and each match of a `dir/*` glob. */
export function workspaceFolders(root, globs) {
  const folders = ["."];
  for (const glob of globs) {
    if (!glob.endsWith("/*") || glob.slice(0, -2).includes("*")) {
      throw new Error(`pnpm-workspace.yaml: only "dir/*" globs are supported, found "${glob}"`);
    }
    const parent = glob.slice(0, -2);
    if (!existsSync(path.join(root, parent))) continue;
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      const folder = `${parent}/${entry.name}`;
      if (entry.isDirectory() && existsSync(path.join(root, folder, "package.json"))) {
        folders.push(folder);
      }
    }
  }
  return folders.sort();
}

/**
 * Problems with the catalog, given each workspace's manifest by folder and the catalog's entry
 * names. Each problem is a line to print.
 */
export function findProblems(manifests, catalog) {
  const uses = new Map();
  for (const [folder, manifest] of manifests) {
    for (const field of FIELDS) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        if (specifier.startsWith("workspace:")) continue;
        if (!uses.has(name)) uses.set(name, []);
        uses.get(name).push({ folder, field, specifier });
      }
    }
  }
  const problems = [];
  for (const [name, declared] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
    const inCatalog = catalog.includes(name);
    if (declared.length < 2 && !inCatalog) continue;
    for (const { folder, field, specifier } of declared) {
      if (specifier.startsWith("catalog:")) continue;
      const why = inCatalog ? "it is in the catalog" : `${declared.length} workspaces declare it`;
      problems.push(
        `${folder}/package.json ${field}: "${name}": "${specifier}" must be "catalog:" (${why})`,
      );
    }
  }
  for (const name of catalog) {
    if (!uses.has(name)) {
      problems.push(`pnpm-workspace.yaml catalog: "${name}" is used by no workspace; remove it`);
    }
  }
  return problems;
}

export function check(root) {
  const { globs, catalog } = parseWorkspace(
    readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  if (globs.length === 0) throw new Error("no workspace globs found in pnpm-workspace.yaml");
  const manifests = new Map(
    workspaceFolders(root, globs).map((folder) => [
      folder,
      JSON.parse(readFileSync(path.join(root, folder, "package.json"), "utf8")),
    ]),
  );
  return findProblems(manifests, catalog);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const problems = check(root);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      "\nShared dependencies live in the `catalog:` of pnpm-workspace.yaml (see scripts/check/catalog.mjs).",
    );
    process.exitCode = 1;
  }
}
