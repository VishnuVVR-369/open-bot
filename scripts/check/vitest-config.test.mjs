// Every workspace package that runs Vitest uses the shared settings in vitest.shared.mjs, so no
// two packages share a module cache directory (see that file for why).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..", "..");
const workspaces = ["apps", "packages", "tools"].flatMap((dir) =>
  readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .filter((dir) => existsSync(path.join(root, dir, "package.json"))),
);

const runsVitest = (dir) => {
  const { scripts = {} } = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
  return Object.values(scripts).some((script) => /\bvitest\b/.test(script));
};

test("every package that runs Vitest has a vitest.config.mts with the shared settings", () => {
  const withVitest = workspaces.filter(runsVitest);
  assert.ok(withVitest.length > 10, `found only ${withVitest.length} packages that run Vitest`);
  for (const dir of withVitest) {
    const config = path.join(root, dir, "vitest.config.mts");
    assert.ok(
      existsSync(config),
      `${dir} runs Vitest without a vitest.config.mts; copy one from packages/domain`,
    );
    const text = readFileSync(config, "utf8");
    assert.match(
      text,
      /from "\.\.\/\.\.\/vitest\.shared\.mjs"/,
      `${dir}/vitest.config.mts must import sharedTest`,
    );
    assert.match(
      text,
      /test:\s*\{\s*\.\.\.sharedTest\b/,
      `${dir}/vitest.config.mts must spread sharedTest into test`,
    );
  }
});
