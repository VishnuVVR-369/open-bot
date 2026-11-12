// Unit tests for the import graph check (scripts/check/imports.mjs and import-graph.mjs):
// `pnpm test:scripts`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { buildGraph, cycleGroups, importPath, workspaceOf } from "./import-graph.mjs";
import { BASELINE, analyze, compare, growth, snapshot } from "./imports.mjs";

const graph = (shape) =>
  new Map(
    Object.entries(shape).map(([from, targets]) => [
      from,
      new Map(targets.map((to) => [to, { specifier: `./${to}`, line: 1 }])),
    ]),
  );

describe("cycleGroups and importPath", () => {
  it("finds each cycle's files, and the way back", () => {
    const edges = graph({ a: ["b"], b: ["c"], c: ["a", "d"], d: [], e: ["f"], f: ["e"], g: ["g"] });
    assert.deepEqual(cycleGroups(edges), [
      ["a", "b", "c"],
      ["e", "f"],
    ]);
    assert.deepEqual(importPath(edges, "b", "a"), ["b", "c", "a"]);
    assert.equal(importPath(edges, "d", "a"), null);
  });

  it("handles long chains without recursion", () => {
    const shape = {};
    for (let i = 0; i < 20000; i++) shape[`n${i}`] = [`n${(i + 1) % 20000}`];
    assert.equal(cycleGroups(graph(shape))[0].length, 20000);
  });
});

describe("workspaceOf", () => {
  it("names the workspace, or the folder for code outside one", () => {
    assert.equal(workspaceOf("apps/web/src/x.ts"), "apps/web");
    assert.equal(workspaceOf("packages/db/src/x.ts"), "packages/db");
    assert.equal(workspaceOf("e2e/x.spec.ts"), "e2e");
    assert.equal(workspaceOf("scripts/x.mjs"), null);
  });
});

describe("analyze and compare", () => {
  const edges = graph({
    "apps/w/a.ts": ["apps/w/b.ts", "apps/web/x.ts"],
    "apps/w/b.ts": ["apps/w/a.ts", "packages/p/i.ts"],
    "apps/web/x.ts": [],
    "packages/p/i.ts": [],
  });
  const found = analyze(edges);

  it("lists the imports inside cycles and the imports of another app", () => {
    assert.deepEqual(snapshot(found), {
      cycles: ["apps/w/a.ts -> apps/w/b.ts", "apps/w/b.ts -> apps/w/a.ts"],
      appImports: ["apps/w/a.ts -> apps/web/x.ts"],
    });
  });

  it("passes when the baseline lists them", () => {
    assert.deepEqual(compare(found, snapshot(found)), []);
  });

  it("explains a new cycle with the way back and how to break it", () => {
    const [problem] = compare(found, {
      cycles: ["apps/w/b.ts -> apps/w/a.ts"],
      appImports: snapshot(found).appImports,
    });
    assert.match(
      problem,
      /^apps\/w\/a\.ts:1 imports "\.\/apps\/w\/b\.ts" \(apps\/w\/b\.ts\), which imports it back: apps\/w\/b\.ts -> apps\/w\/a\.ts\n {2}Break each cycle/,
    );
    assert.match(problem, /Type-only imports count too/);
  });

  it("explains a new cross-app import", () => {
    const [problem] = compare(found, { cycles: snapshot(found).cycles, appImports: [] });
    assert.match(
      problem,
      /^apps\/w\/a\.ts:1 imports .* the source of apps\/web\n {2}An app never imports another app's code/,
    );
  });

  it("fails when the baseline lists an import that is gone, so it can only shrink", () => {
    const stale = {
      ...snapshot(found),
      appImports: ["apps/w/a.ts -> apps/web/x.ts", "apps/w/old.ts -> apps/web/x.ts"],
    };
    const [problem] = compare(found, stale);
    assert.match(
      problem,
      /lists 1 cross-app imports that no longer exist .*apps\/w\/old\.ts -> apps\/web\/x\.ts\.\n {2}Run pnpm check:imports --update/,
    );
  });

  it("lets a moved file keep its entries but refuses more", () => {
    const before = { cycles: ["x -> y", "y -> x"], appImports: [] };
    assert.deepEqual(growth({ cycles: ["x2 -> y", "y -> x2"], appImports: [] }, before), []);
    assert.deepEqual(
      growth({ cycles: ["x -> y", "y -> z", "z -> x"], appImports: ["a -> b"] }, before),
      ["cycles 2 -> 3", "appImports 0 -> 1"],
    );
  });
});

describe("buildGraph and the command line", () => {
  const script = fileURLToPath(new URL("./imports.mjs", import.meta.url));
  let root;
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const baseline = () => JSON.parse(readFileSync(path.join(root, BASELINE), "utf8"));

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "imports-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(path.join(root, path.dirname(BASELINE)), { recursive: true });
    write(
      "apps/web/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          paths: { "@/*": ["./src/*"] },
        },
      }),
    );
    // A type-only cycle through a tsconfig path alias.
    write("apps/web/src/a.ts", 'import type { B } from "@/b";\nexport type A = { b?: B };\n');
    write("apps/web/src/b.tsx", 'import type { A } from "./a";\nexport type B = { a?: A };\n');
    write("apps/web/src/c.ts", 'export const c = () => import("./a");\n');
    write("apps/worker/src/x.test.ts", 'import { c } from "../../web/src/c";\nexport { c };\n');
    write("packages/agent/src/protocol/p.ts", 'import "../../../../apps/web/src/a";\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("resolves aliases, type-only and dynamic imports, and skips generated code", () => {
    const { files, edges } = buildGraph(root);
    assert.deepEqual(files, [
      "apps/web/src/a.ts",
      "apps/web/src/b.tsx",
      "apps/web/src/c.ts",
      "apps/worker/src/x.test.ts",
    ]);
    assert.deepEqual([...edges.get("apps/web/src/a.ts").keys()], ["apps/web/src/b.tsx"]);
    assert.deepEqual([...edges.get("apps/web/src/c.ts").keys()], ["apps/web/src/a.ts"]);
    assert.deepEqual(edges.get("apps/worker/src/x.test.ts").get("apps/web/src/c.ts"), {
      specifier: "../../web/src/c",
      line: 1,
    });
  });

  it("fails on today's imports until a reviewed baseline lists them", () => {
    const check = run();
    assert.equal(check.status, 1);
    assert.match(
      check.output,
      /apps\/web\/src\/a\.ts:1 imports "@\/b" \(apps\/web\/src\/b\.tsx\), which imports it back/,
    );
    assert.match(
      check.output,
      /apps\/worker\/src\/x\.test\.ts:1 imports .* the source of apps\/web/,
    );
    assert.equal(run("--update").status, 1);
    assert.equal(run("--update", "--allow-growth").status, 0);
    assert.deepEqual(baseline(), {
      cycles: [
        "apps/web/src/a.ts -> apps/web/src/b.tsx",
        "apps/web/src/b.tsx -> apps/web/src/a.ts",
      ],
      appImports: ["apps/worker/src/x.test.ts -> apps/web/src/c.ts"],
    });
    const ok = run();
    assert.equal(ok.status, 0, ok.output);
    assert.match(ok.output, /1 cycles of 2 files, 2 imports in them, 1 cross-app imports/);
  });

  it("fails on a new cycle, and --update refuses to absorb it", () => {
    run("--update", "--allow-growth");
    write(
      "apps/web/src/b.tsx",
      'import type { A } from "./a";\nimport "./c";\nexport type B = { a?: A };\n',
    );
    const check = run();
    assert.equal(check.status, 1);
    assert.match(
      check.output,
      /apps\/web\/src\/b\.tsx:2 imports "\.\/c" \(apps\/web\/src\/c\.ts\), which imports it back: apps\/web\/src\/c\.ts -> apps\/web\/src\/a\.ts -> apps\/web\/src\/b\.tsx/,
    );
    const update = run("--update");
    assert.equal(update.status, 1);
    assert.match(update.output, /cycles 2 -> 4/);
  });

  it("makes the baseline shrink once a cycle is broken", () => {
    run("--update", "--allow-growth");
    write("apps/web/src/b.tsx", "export type B = { a?: unknown };\n");
    assert.match(run().output, /lists 2 imports in cycles that no longer exist/);
    assert.equal(run("--update").status, 0);
    assert.deepEqual(baseline().cycles, []);
    assert.equal(run().status, 0);
  });
});
