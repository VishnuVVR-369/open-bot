// Unit tests for the import graph check (scripts/check/imports.mjs and import-graph.mjs):
// `pnpm test:scripts`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { buildGraph, cycleGroups, importPath, workspaceOf } from "./import-graph.mjs";
import { analyze, problems } from "./imports.mjs";

/** Where the cycle baseline used to be. */
const BASELINE = "scripts/check/imports-baseline.json";

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

describe("analyze and problems", () => {
  const edges = graph({
    "apps/w/a.ts": ["apps/w/b.ts", "apps/web/x.ts"],
    "apps/w/b.ts": ["apps/w/a.ts", "packages/p/i.ts"],
    "apps/web/x.ts": [],
    "packages/p/i.ts": [],
  });
  const found = analyze(edges);

  it("lists the imports inside cycles and the imports of another app", () => {
    assert.deepEqual(
      [...found.cycles.keys()],
      ["apps/w/a.ts -> apps/w/b.ts", "apps/w/b.ts -> apps/w/a.ts"],
    );
    assert.deepEqual([...found.appImports.keys()], ["apps/w/a.ts -> apps/web/x.ts"]);
  });

  it("explains a cycle with the way back and how to break it", () => {
    const [cycle] = problems(found);
    assert.match(
      cycle,
      /^apps\/w\/a\.ts:1 imports "\.\/apps\/w\/b\.ts" \(apps\/w\/b\.ts\), which imports it back: apps\/w\/b\.ts -> apps\/w\/a\.ts\n/,
    );
    assert.match(cycle, /\n {2}Break each cycle/);
    assert.match(cycle, /Type-only imports count too/);
  });

  it("explains a cross-app import", () => {
    const [, appImport] = problems(found);
    assert.match(
      appImport,
      /^apps\/w\/a\.ts:1 imports .* the source of apps\/web\n {2}An app never imports another app's code/,
    );
  });

  it("passes a graph with neither", () => {
    const clean = graph({ "apps/w/a.ts": ["apps/w/b.ts", "packages/p/i.ts"], "apps/w/b.ts": [] });
    assert.deepEqual(problems(analyze(clean)), []);
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

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "imports-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
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
    write("apps/web/src/a.ts", 'import type { B } from "@/b";\nexport type A = { b?: B };\n');
    write("apps/web/src/b.tsx", "export type B = { a?: unknown };\n");
    write("apps/web/src/c.ts", 'export const c = () => import("./a");\n');
    write("packages/agent/src/protocol/p.ts", 'import "../../../../apps/web/src/a";\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("resolves aliases, type-only and dynamic imports, and skips generated code", () => {
    write("apps/worker/src/x.test.ts", 'import { c } from "../../web/src/c";\nexport { c };\n');
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

  it("passes a clean graph", () => {
    const ok = run();
    assert.equal(ok.status, 0, ok.output);
    assert.match(ok.output, /No import cycles or cross-app imports/);
  });

  it("fails on a new cycle, type-only and through an alias, and nothing can absorb it", () => {
    write("apps/web/src/b.tsx", 'import type { A } from "./a";\nexport type B = { a?: A };\n');
    for (const args of [[], ["--update"], ["--update", "--allow-growth"]]) {
      const check = run(...args);
      assert.equal(check.status, 1, args.join(" "));
      assert.match(
        check.output,
        /apps\/web\/src\/a\.ts:1 imports "@\/b" \(apps\/web\/src\/b\.tsx\), which imports it back: apps\/web\/src\/b\.tsx -> apps\/web\/src\/a\.ts/,
      );
      assert.match(check.output, /apps\/web\/src\/b\.tsx:1 imports "\.\/a"/);
    }
    // A baseline file from before cycles were refused changes nothing either.
    write(
      BASELINE,
      JSON.stringify({
        cycles: [
          "apps/web/src/a.ts -> apps/web/src/b.tsx",
          "apps/web/src/b.tsx -> apps/web/src/a.ts",
        ],
      }),
    );
    assert.equal(run().status, 1);
  });

  it("fails on an app importing another app's source", () => {
    write("apps/worker/src/x.test.ts", 'import { c } from "../../web/src/c";\nexport { c };\n');
    const check = run();
    assert.equal(check.status, 1);
    assert.match(
      check.output,
      /apps\/worker\/src\/x\.test\.ts:1 imports "\.\.\/\.\.\/web\/src\/c" \(apps\/web\/src\/c\.ts\), the source of apps\/web/,
    );
  });
});
