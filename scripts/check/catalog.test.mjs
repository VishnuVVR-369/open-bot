// Unit tests for the shared dependency catalog check (scripts/check/catalog.mjs): `pnpm test:scripts`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { check, findProblems, parseWorkspace } from "./catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("parseWorkspace", () => {
  it("reads the workspace globs and the default catalog's names, quoted or not", () => {
    const yaml = [
      "packages:",
      "  - apps/*",
      '  - "packages/*"',
      "",
      "# A comment between sections",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "catalog:",
      '  "@types/node": "^24.19.2"',
      "  # a comment inside the catalog",
      "  zod: ^4.6.7",
      "  'react': 19.3.0",
      "patchedDependencies:",
      "  drizzle-orm@0.45.4: patches/drizzle-orm@0.45.4.patch",
    ].join("\n");
    assert.deepEqual(parseWorkspace(yaml), {
      globs: ["apps/*", "packages/*"],
      catalog: ["@types/node", "zod", "react"],
    });
  });
});

describe("findProblems", () => {
  const manifests = (entries) => new Map(Object.entries(entries));

  it("passes when every shared dependency uses the catalog", () => {
    const problems = findProblems(
      manifests({
        ".": { devDependencies: { zod: "catalog:", "@open-bot/db": "workspace:*" } },
        "apps/web": { dependencies: { zod: "catalog:", next: "16.4.6" } },
        "apps/worker": { dependencies: { "@open-bot/db": "workspace:*" } },
      }),
      ["zod"],
    );
    assert.deepEqual(problems, []);
  });

  it("fails a dependency two workspaces declare with versions, naming each", () => {
    const problems = findProblems(
      manifests({
        "apps/web": { dependencies: { ws: "^8.22.0" } },
        "apps/worker": { devDependencies: { ws: "^8.22.0" } },
      }),
      [],
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^apps\/web\/package.json dependencies: "ws": "\^8.22.0"/);
    assert.match(problems[1], /^apps\/worker\/package.json devDependencies: .*2 workspaces/);
  });

  it("fails a new workspace that declares a catalog dependency with a version", () => {
    const problems = findProblems(
      manifests({
        "apps/web": { dependencies: { zod: "catalog:" } },
        "apps/worker": { dependencies: { zod: "^3.25.0" } },
      }),
      ["zod"],
    );
    assert.deepEqual(problems, [
      'apps/worker/package.json dependencies: "zod": "^3.25.0" must be "catalog:" (it is in the catalog)',
    ]);
  });

  it("fails a catalog entry no workspace uses", () => {
    const problems = findProblems(manifests({ ".": {} }), ["left-over"]);
    assert.match(problems[0], /"left-over" is used by no workspace/);
  });

  it("accepts named catalogs and ignores peer dependencies", () => {
    const problems = findProblems(
      manifests({
        "apps/a": { dependencies: { react: "catalog:react19" }, peerDependencies: { ws: "*" } },
        "apps/b": { dependencies: { react: "catalog:react19" }, peerDependencies: { ws: "^8" } },
      }),
      [],
    );
    assert.deepEqual(problems, []);
  });
});

describe("check", () => {
  const dirs = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function workspace(files) {
    const dir = mkdtempSync(path.join(tmpdir(), "catalog-check-"));
    dirs.push(dir);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(
        path.join(dir, file),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return dir;
  }

  it("finds the workspaces from pnpm-workspace.yaml, the root included", () => {
    const dir = workspace({
      "pnpm-workspace.yaml": "packages:\n  - apps/*\ncatalog:\n  zod: ^4.6.7\n",
      "package.json": { devDependencies: { zod: "4.6.7" } },
      "apps/web/package.json": { dependencies: { zod: "catalog:" } },
      "apps/notes/README.md": "not a workspace",
      "other/package.json": { dependencies: { zod: "^3" } },
    });
    assert.deepEqual(check(dir), [
      './package.json devDependencies: "zod": "4.6.7" must be "catalog:" (it is in the catalog)',
    ]);
  });

  it("refuses a workspace glob it cannot expand", () => {
    const dir = workspace({ "pnpm-workspace.yaml": "packages:\n  - apps/**\n" });
    assert.throws(() => check(dir), /only "dir\/\*" globs/);
  });

  it("passes on this repository", () => {
    assert.deepEqual(check(repoRoot), []);
  });
});
