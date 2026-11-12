// Unit tests for the file size budget (scripts/check/file-size.mjs): `pnpm test:scripts`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { BASELINE, LIMIT, compare, growth, linesOfCode, measure } from "./file-size.mjs";

describe("linesOfCode", () => {
  it("skips blank lines and every kind of comment", () => {
    const text = [
      "// a line comment",
      "/** a doc comment",
      " * over lines",
      " */",
      "const a = 1; // trailing",
      "",
      "/* block */ const b = 2;",
      "/*",
      "  a block over lines",
      "*/",
      "   ",
    ].join("\n");
    assert.equal(linesOfCode(text), 2);
  });

  it("counts strings that look like comments, and every line of a template", () => {
    const text = 'const url = "https://example.com"; // ok\nconst t = `one\n\n// two`;\n';
    assert.equal(linesOfCode(text), 4);
  });

  it("reads JSX text as text, not comments", () => {
    const text = [
      "export const A = () => (",
      "  <p>",
      "    // shown on the page",
      "",
      "    <b>hi</b>",
      "  </p>",
      ");",
    ].join("\n");
    assert.equal(linesOfCode(text, "a.tsx"), 6);
  });
});

describe("compare", () => {
  const big = LIMIT + 1;

  it("passes files under the limit and baselined files at their size", () => {
    assert.deepEqual(compare({ "a.ts": LIMIT, "b.ts": 700 }, { "b.ts": 700 }), []);
  });

  it("fails a new file over the limit and says to split it", () => {
    const [problem] = compare({ "a.ts": big }, {});
    assert.match(problem, new RegExp(`^a\\.ts: ${big} lines of code, over the limit of ${LIMIT}`));
    assert.match(problem, /Split it: move a part/);
    assert.match(problem, /moved or renamed .* pnpm check:file-size --update/);
  });

  it("fails a baselined file that grew", () => {
    const [problem] = compare({ "a.ts": 701 }, { "a.ts": 700 });
    assert.match(problem, /^a\.ts: 701 lines of code\..*keep 700 until it is split, but not grow/);
  });

  it("fails a baseline that is higher than the code, so it can only shrink", () => {
    const shrunk = compare({ "a.ts": 650, "b.ts": 10 }, { "a.ts": 700, "b.ts": 700, "c.ts": 700 });
    assert.equal(shrunk.length, 3);
    assert.match(
      shrunk[0],
      /a\.ts: the baseline allows 700 .* it has 650\. Run pnpm check:file-size --update/,
    );
    assert.match(shrunk[2], /c\.ts: .*the file is gone/);
  });
});

describe("growth", () => {
  it("allows moving a file and shrinking, but not growing", () => {
    assert.deepEqual(growth({ "b.ts": 700 }, { "a.ts": 700 }), []);
    assert.deepEqual(growth({ "a.ts": 650 }, { "a.ts": 700 }), []);
    assert.deepEqual(growth({ "a.ts": 701 }, { "a.ts": 700 }), [
      "a.ts 700 -> 701",
      "lines in files over the limit 700 -> 701",
    ]);
    assert.deepEqual(growth({ "a.ts": 650, "b.ts": 650 }, { "a.ts": 700 }), [
      "files over the limit 1 -> 2",
      "lines in files over the limit 700 -> 1300",
    ]);
  });
});

describe("measure and the command line", () => {
  const script = fileURLToPath(new URL("./file-size.mjs", import.meta.url));
  let root;
  const code = (lines) =>
    Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n");
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
    root = mkdtempSync(path.join(tmpdir(), "file-size-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(path.join(root, path.dirname(BASELINE)), { recursive: true });
    write(".gitignore", "dist/\n");
    write("apps/web/src/big.tsx", `// header\n\n${code(LIMIT + 10)}\n`);
    write("apps/web/src/small.ts", code(3));
    write("apps/web/dist/ignored.js", code(LIMIT + 10));
    write("packages/agent/src/protocol/generated.ts", code(LIMIT + 10));
    write("e2e/out-of-scope.ts", code(LIMIT + 10));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("measures code in apps and packages, skipping ignored and generated files", () => {
    assert.deepEqual(measure(root), {
      "apps/web/src/big.tsx": LIMIT + 10,
      "apps/web/src/small.ts": 3,
    });
  });

  it("fails a file over the limit until a reviewed baseline lists it", () => {
    const check = run();
    assert.equal(check.status, 1);
    assert.match(
      check.output,
      /apps\/web\/src\/big\.tsx: 610 lines of code, over the limit of 600/,
    );
    const refused = run("--update");
    assert.equal(refused.status, 1);
    assert.match(refused.output, /files over the limit 0 -> 1/);
    assert.equal(run("--update", "--allow-growth").status, 0);
    assert.deepEqual(baseline(), { "apps/web/src/big.tsx": LIMIT + 10 });
    const ok = run();
    assert.equal(ok.status, 0, ok.output);
    assert.match(ok.output, /1 files over the 600-line limit are baselined/);
  });

  it("makes the baseline follow a file down, and refuses to let it grow back", () => {
    run("--update", "--allow-growth");
    write("apps/web/src/big.tsx", code(LIMIT + 5));
    assert.match(run().output, /baseline allows 610 lines of code but it has 605/);
    assert.equal(run("--update").status, 0);
    assert.deepEqual(baseline(), { "apps/web/src/big.tsx": LIMIT + 5 });
    write("apps/web/src/big.tsx", code(LIMIT + 6));
    assert.match(run().output, /606 lines of code\. It is over the limit/);
    assert.equal(run("--update").status, 1);
  });

  it("follows a moved file, and drops a file once it is under the limit", () => {
    run("--update", "--allow-growth");
    renameSync(path.join(root, "apps/web/src/big.tsx"), path.join(root, "apps/web/src/moved.tsx"));
    assert.equal(run().status, 1);
    assert.equal(run("--update").status, 0);
    assert.deepEqual(baseline(), { "apps/web/src/moved.tsx": LIMIT + 10 });
    write("apps/web/src/moved.tsx", code(LIMIT));
    assert.equal(run("--update").status, 0);
    assert.deepEqual(baseline(), {});
    assert.equal(run().status, 0);
  });

  it("reports files over the target without failing", () => {
    write("apps/web/src/medium.ts", code(450));
    const report = run("--report");
    assert.equal(report.status, 0);
    assert.match(
      report.output,
      / {2}610 {2}apps\/web\/src\/big\.tsx {2}\(over the limit\)\n {2}450 {2}apps\/web\/src\/medium\.ts\n2 files over the target/,
    );
  });
});
