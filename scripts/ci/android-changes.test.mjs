import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { androidInputs, needsAndroid } from "./android-changes.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "android-changes-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const write = (file, content = "changed\n") => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};
git("init", "--quiet");
git("config", "user.email", "ci@example.com");
git("config", "user.name", "CI test");
for (const [directory, name, dependencies] of [
  ["apps/mobile", "@open-bot/mobile", { "@open-bot/api": "workspace:*" }],
  ["packages/api", "@open-bot/api", { "@open-bot/domain": "workspace:*" }],
  ["packages/domain", "@open-bot/domain", {}],
  ["packages/egress", "@open-bot/egress", {}],
  ["apps/web", "@open-bot/web", {}],
])
  write(`${directory}/package.json`, JSON.stringify({ name, dependencies }));
write("apps/mobile/native.kt");
git("add", ".");
git("commit", "--quiet", "-m", "base");
const base = git("rev-parse", "HEAD");

function commit(file, content) {
  write(file, content);
  git("add", "--all");
  git("commit", "--quiet", "-m", "change");
  return git("rev-parse", "HEAD");
}

test("follows transitive mobile workspace dependencies and Kotlin vectors", () => {
  assert.deepEqual([...androidInputs(root)].sort(), [
    "apps/mobile",
    "packages/api",
    "packages/domain",
    "packages/egress",
  ]);
});

test("docs and unrelated app changes skip Android", () => {
  const docs = commit("apps/site/src/app/docs/development/page.mdx");
  assert.equal(needsAndroid(root, base, docs), false);
  const web = commit("apps/web/src/app/page.tsx");
  assert.equal(needsAndroid(root, base, web), false);
  const readme = commit("README.md");
  assert.equal(needsAndroid(root, base, readme), false);
});

test("mobile, shared sources, vectors and global build inputs run Android", () => {
  for (const file of [
    "apps/mobile/src/app/index.tsx",
    "packages/api/src/contract.ts",
    "packages/domain/src/index.ts",
    "packages/egress/test-vectors/frame.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    ".npmrc",
    ".github/workflows/ci.yml",
    "scripts/ci/android-ccache.gradle",
    "patches/native.patch",
  ]) {
    const before = git("rev-parse", "HEAD");
    assert.equal(needsAndroid(root, before, commit(file)), true, file);
  }
});

test("uses the entire PR diff even when its latest commit only changes docs", () => {
  const head = commit("README.md", "more docs\n");
  assert.equal(needsAndroid(root, `${head}^`, head), false);
  assert.equal(needsAndroid(root, base, head), true);
});

test("renames out of mobile and deletions still run Android", () => {
  const before = git("rev-parse", "HEAD");
  git("mv", "apps/mobile/native.kt", "apps/web/native.kt");
  git("commit", "--quiet", "-m", "move");
  assert.equal(needsAndroid(root, before, "HEAD"), true);
  const previous = git("rev-parse", "HEAD");
  git("rm", "packages/domain/src/index.ts");
  git("commit", "--quiet", "-m", "delete");
  assert.equal(needsAndroid(root, previous, "HEAD"), true);
});

test("discovers new transitive dependencies and handles dependency cycles", () => {
  write(
    "packages/domain/package.json",
    JSON.stringify({
      name: "@open-bot/domain",
      optionalDependencies: { "@open-bot/new": "workspace:*" },
    }),
  );
  const before = commit(
    "packages/new/package.json",
    JSON.stringify({
      name: "@open-bot/new",
      devDependencies: { "@open-bot/mobile": "workspace:*" },
    }),
  );
  const head = commit("packages/new/src/index.ts");
  assert.equal(needsAndroid(root, before, head), true);
});

test("CLI writes a skipped PR result and always builds on pushes to main", () => {
  const before = git("rev-parse", "HEAD");
  const head = commit("apps/site/README.md");
  const output = path.join(root, ".git", "actions-output");
  const script = fileURLToPath(new URL("./android-changes.mjs", import.meta.url));
  for (const [event, expected] of [
    ["pull_request", false],
    ["push", true],
  ]) {
    writeFileSync(output, "");
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        BASE_SHA: before,
        HEAD_SHA: head,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(readFileSync(output, "utf8"), `android=${expected}\n`);
  }
});

test("missing history or manifests fall back to running checks", () => {
  assert.equal(needsAndroid(root, "", "HEAD"), true);
  assert.equal(needsAndroid(root, "invalid-ref", "HEAD"), true);
  write("packages/domain/package.json", "invalid json");
  assert.equal(needsAndroid(root, base, "HEAD"), true);
});
