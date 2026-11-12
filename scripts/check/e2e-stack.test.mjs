// The end-to-end specs write to and clean up the stack they test, so they must be told which one,
// and the teardown must delete only the teammates they made (e2e/stack.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readStack, TEST_TEAMMATE_NAME, uniqueName } from "../../e2e/stack.ts";

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

test("the teardown matches the names tests make, and their duplicates", () => {
  for (let i = 0; i < 200; i++) {
    const name = uniqueName("Tess");
    assert.match(name, TEST_TEAMMATE_NAME);
    assert.match(`${name} 2`, TEST_TEAMMATE_NAME);
  }
});

test("the teardown leaves names the old pattern deleted", () => {
  for (const name of ["Annabel", "Solaris", "Bobbie1", "Ivy2026", "Tess1a2b", "E2e", "E2eTess"])
    assert.doesNotMatch(name, TEST_TEAMMATE_NAME);
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

test("the teardown only deletes rows the run created", () => {
  const source = readFileSync(path.join(root, "e2e", "global-teardown.ts"), "utf8");
  const deletes = source.split("\n").filter((line) => line.includes("delete from "));
  assert.ok(deletes.length > 0);
  // Each goes through recent() (created since the run started) or deletes run-made teammates.
  for (const line of deletes)
    assert.match(line, /recent\([`"]delete from |delete from bots where id in \(\$\{teammates\}\)/);
});
