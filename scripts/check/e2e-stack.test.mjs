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

test("no spec or helper falls back to a default stack", () => {
  const dir = path.join(root, "e2e");
  const offenders = readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && file !== "stack.ts")
    .filter((file) =>
      /process\.env\.(DATABASE_URL|WORKER_URL|BOTD_URL|E2E_BASE_URL)\b/.test(
        readFileSync(path.join(dir, file), "utf8"),
      ),
    );
  assert.deepEqual(offenders, []);
});
