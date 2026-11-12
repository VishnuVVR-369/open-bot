// The end-to-end specs write to and clean up the stack they test, so they must be told which one,
// and the teardown must delete only what the run made (e2e/stack.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  newRunTag,
  readStack,
  RUN_TAG,
  runTag,
  TEST_LABEL,
  TEST_SLUG,
  testLabel,
  testSlug,
  testTeammateName,
  uniqueName,
} from "../../e2e/stack.ts";

const root = path.join(import.meta.dirname, "..", "..");
const named = {
  E2E_BASE_URL: "http://localhost:3300",
  DATABASE_URL: "postgres://u:p@127.0.0.1:55432/scratch",
  WORKER_URL: "http://127.0.0.1:4101",
  BOTD_URL: "http://127.0.0.1:7999",
};

test("a stack named in full is used as given", () => {
  assert.deepEqual(readStack(named), {
    baseUrl: named.E2E_BASE_URL,
    databaseUrl: named.DATABASE_URL,
    workerUrl: named.WORKER_URL,
    botdUrl: named.BOTD_URL,
  });
});

test("a stack missing any part is refused, naming what to set", () => {
  assert.throws(() => readStack({}), /set E2E_BASE_URL, DATABASE_URL, WORKER_URL, BOTD_URL/);
  for (const name of Object.keys(named)) {
    const env = { ...named, [name]: undefined };
    assert.throws(() => readStack(env), new RegExp(`set ${name},? `));
  }
});

test("E2E_STACK=dev is the development stack, and can't be mixed with another", () => {
  assert.equal(
    readStack({ E2E_STACK: "dev" }).databaseUrl,
    "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  );
  assert.throws(
    () => readStack({ E2E_STACK: "dev", E2E_BASE_URL: named.E2E_BASE_URL }),
    /leave E2E_BASE_URL unset/,
  );
  assert.throws(() => readStack({ ...named, E2E_STACK: "prod" }), /only be "dev"/);
});

/** Runs `work` as a spec in the run tagged `tag` would. */
function inRun(tag, work) {
  const before = process.env[RUN_TAG];
  process.env[RUN_TAG] = tag;
  try {
    return work();
  } finally {
    if (before === undefined) delete process.env[RUN_TAG];
    else process.env[RUN_TAG] = before;
  }
}

/** SQL `like`, for the patterns the teardown uses. */
const like = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("%", ".*")
      .replaceAll("_", ".")}$`,
  );

test("the teardown matches what its run names, and their duplicates", () => {
  for (let i = 0; i < 200; i++) {
    const tag = newRunTag();
    inRun(tag, () => {
      const name = uniqueName("Tess");
      assert.match(name, testTeammateName(tag));
      assert.match(`${name} 2`, testTeammateName(tag));
      assert.match(testLabel("GitHub x1y2"), like(TEST_LABEL(tag)));
      assert.match(testSlug("x1y2.txt"), like(TEST_SLUG(tag)));
    });
  }
});

test("the teardown leaves what another run, or you, named", () => {
  const [mine, theirs] = ["k7q2", "a1b2"];
  const other = inRun(theirs, () => [uniqueName("Tess"), testLabel("group"), testSlug("x1y2")]);
  assert.doesNotMatch(other[0], testTeammateName(mine));
  assert.doesNotMatch(other[1], like(TEST_LABEL(mine)));
  assert.doesNotMatch(other[2], like(TEST_SLUG(mine)));
  for (const name of ["Annabel", "Tess1a2b", "E2e", "E2eTess", "E2eReviewer", "E2eTess4kq9"])
    assert.doesNotMatch(name, testTeammateName(mine));
  for (const label of ["E2E group", "E2E GitHub", "E2E Orders x1y2"])
    assert.doesNotMatch(label, like(TEST_LABEL(mine)));
  assert.doesNotMatch("e2e-delete-me.txt", like(TEST_SLUG(mine)));
});

test("specs can't name things outside a run", () => {
  assert.throws(() => runTag({}), /E2E_RUN_TAG isn't set/);
  assert.throws(() => runTag({ [RUN_TAG]: "x%" }), /E2E_RUN_TAG isn't set/);
});

test("a stack URL that leaves its target to defaults is refused", () => {
  for (const url of ["postgres://", "postgres://u@127.0.0.1:5432", "postgres://u@127.0.0.1/", "x"])
    assert.throws(() => readStack({ ...named, DATABASE_URL: url }), /DATABASE_URL/);
  for (const url of ["127.0.0.1:4101", "ws://127.0.0.1:4101", "http://"])
    assert.throws(() => readStack({ ...named, WORKER_URL: url }), /WORKER_URL/);
});

const STACK_VARIABLES = "DATABASE_URL|WORKER_URL|BOTD_URL|E2E_BASE_URL";

/** Whether `source` reads a stack variable itself, in any of the usual ways. */
function readsStackVariable(source) {
  return [
    new RegExp(`process\\.env\\s*\\.\\s*(${STACK_VARIABLES})\\b`),
    new RegExp(`process\\.env\\s*\\[\\s*["'\`](${STACK_VARIABLES})["'\`]\\s*\\]`),
    new RegExp(`\\{[^}]*\\b(${STACK_VARIABLES})\\b[^}]*\\}\\s*=\\s*process\\.env\\b`),
  ].some((pattern) => pattern.test(source));
}

test("the check finds every way of reading a stack variable", () => {
  for (const source of [
    "const url = process.env.DATABASE_URL ?? fallback;",
    'const url = process.env["WORKER_URL"] ?? fallback;',
    "const url = process.env['BOTD_URL'];",
    "const { E2E_BASE_URL } = process.env;",
    "const { A, DATABASE_URL: url = fallback } = process.env;",
  ])
    assert.ok(readsStackVariable(source), source);
  for (const source of ["e2eStack().databaseUrl", "process.env.WORKER_SECRET", "process.env[name]"])
    assert.ok(!readsStackVariable(source), source);
});

test("no spec or helper falls back to a default stack", () => {
  const dir = path.join(root, "e2e");
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && file !== "stack.ts")
    .map((file) => path.join(dir, file));
  const offenders = [...files, path.join(root, "playwright.config.ts")]
    .filter((file) => readsStackVariable(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});

test("cleanup only deletes what carries the run's tag", () => {
  const source = readFileSync(path.join(root, "e2e", "global-teardown.ts"), "utf8");
  const deletes = source.split("\n").filter((line) => line.includes("delete from "));
  assert.ok(deletes.length > 0);
  // Each matches with the run's label or slug pattern, or deletes the run's teammates.
  for (const line of deletes)
    assert.match(
      line,
      /(like \$\d.*(label|slug)\b|bot_id in \(\$\{theirs\}\)|id in \(\$\{theirs\}\))/,
    );
  // No spec cleans up by the old shared prefixes, which match every run's rows and yours.
  const dir = path.join(root, "e2e");
  const shared = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => /like '(E2E |e2e-)/i.test(readFileSync(path.join(dir, file), "utf8")));
  assert.deepEqual(shared, []);
});
