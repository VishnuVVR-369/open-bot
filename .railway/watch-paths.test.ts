// Keeps the Railway watch paths in step with what each service actually builds from.
// A folder missing here means a change there would silently never reach production.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { type DeployedService, ROOT_FILES, SERVICE_FOLDERS, watchPatterns } from "./watch-paths.ts";

const root = join(import.meta.dirname, "..");

/** The workspace package each service builds, plus folders read outside pnpm. */
const ENTRIES: Record<DeployedService, { app: string; extra: string[] }> = {
  web: { app: "apps/web", extra: [] },
  worker: { app: "apps/worker", extra: [] },
  pages: { app: "apps/pages", extra: [] },
  computer: { app: "apps/botd", extra: ["images/computer"] },
};

type Manifest = Record<string, Record<string, string> | undefined> & { name?: string };

function readManifest(folder: string): Manifest {
  return JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as Manifest;
}

/** Every workspace folder by package name, from the globs in pnpm-workspace.yaml. */
function workspaceFolders(): Map<string, string> {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s+-\s+"?([^"\s]+)\/\*"?\s*$/gm)].map((match) => match[1]!);
  assert.ok(globs.length > 0, "no workspace globs found in pnpm-workspace.yaml");
  const byName = new Map<string, string>();
  for (const parent of globs) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const folder = `${parent}/${entry.name}`;
      if (!entry.isDirectory() || !existsSync(join(root, folder, "package.json"))) continue;
      const { name } = readManifest(folder);
      if (name) byName.set(name, folder);
    }
  }
  return byName;
}

/** The app folder and every workspace package it reaches, dev dependencies included. */
function buildFolders(app: string, workspace: Map<string, string>): Set<string> {
  const seen = new Set<string>();
  const queue = [app];
  while (queue.length > 0) {
    const folder = queue.shift()!;
    if (seen.has(folder)) continue;
    seen.add(folder);
    const manifest = readManifest(folder);
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependency = workspace.get(name);
        if (dependency) queue.push(dependency);
      }
    }
  }
  return seen;
}

const sorted = (values: Iterable<string>) => [...values].sort();

for (const service of Object.keys(ENTRIES) as DeployedService[]) {
  test(`${service} watches exactly the folders its build reads`, () => {
    const { app, extra } = ENTRIES[service];
    const expected = new Set([...buildFolders(app, workspaceFolders()), ...extra]);
    assert.deepEqual(sorted(SERVICE_FOLDERS[service]), sorted(expected));
  });
}

test("every watched folder and root file exists", () => {
  for (const folder of new Set(Object.values(SERVICE_FOLDERS).flat())) {
    assert.ok(existsSync(join(root, folder, ".")), `${folder} does not exist`);
  }
  for (const file of ROOT_FILES) {
    assert.ok(existsSync(join(root, file)), `${file} does not exist`);
  }
});

test("the computer image copies nothing from outside its watched paths", () => {
  const dockerfile = readFileSync(join(root, "images/computer/Dockerfile"), "utf8");
  const sources = [...dockerfile.matchAll(/^(?:COPY|ADD)\s+(?!--from)(.+)$/gm)].flatMap((match) => {
    const parts = match[1]!
      .trim()
      .split(/\s+/)
      .filter((part) => !part.startsWith("--"));
    return parts.slice(0, -1);
  });
  assert.ok(sources.length > 0, "no COPY sources found in the Dockerfile");
  const watched = [...ROOT_FILES, ...SERVICE_FOLDERS.computer];
  for (const source of sources) {
    const path = source.replace(/^\.\//, "").replace(/\/$/, "");
    assert.ok(
      watched.some((entry) => path === entry || path.startsWith(`${entry}/`)),
      `the Dockerfile copies ${source}, which the computer's watch paths miss`,
    );
  }
});

test("patterns are rooted, and negations come after every include", () => {
  for (const service of Object.keys(SERVICE_FOLDERS) as DeployedService[]) {
    const patterns = watchPatterns(service);
    const firstNegation = patterns.findIndex((pattern) => pattern.startsWith("!"));
    assert.ok(firstNegation > 0, `${service} has no includes before its negations`);
    for (const [index, pattern] of patterns.entries()) {
      if (index < firstNegation) assert.match(pattern, /^\//, `${pattern} is not rooted`);
      else assert.match(pattern, /^!/, `${pattern} is an include after a negation`);
    }
  }
});
