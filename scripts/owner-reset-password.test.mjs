// Runs scripts/owner-reset-password.mjs the way the owner would, against the disposable database
// scripts/test-owner-reset.sh starts. Run it through that script: pnpm test:owner-reset
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = createRequire(path.join(root, "apps/web/package.json"));
const { hashPassword, verifyPassword } = await import(
  pathToFileURL(web.resolve("better-auth/crypto")).href
);
const { default: pg } = await import(pathToFileURL(web.resolve("pg")).href);

const DATABASE_URL = process.env.OWNER_RESET_TEST_DATABASE_URL;
if (!DATABASE_URL || !/owner_reset_test/.test(DATABASE_URL))
  throw new Error("Run this through scripts/test-owner-reset.sh, against its disposable database.");

const OWNER = "owner@example.com";
const client = new pg.Client({ connectionString: DATABASE_URL });

function reset(args, input, env = {}) {
  return spawnSync(process.execPath, ["scripts/owner-reset-password.mjs", ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, DATABASE_URL, OWNER_EMAIL: OWNER, ...env },
  });
}

async function storedHash() {
  const { rows } = await client.query(
    `select a.password from account a join "user" u on u.id = a.user_id
     where u.email = $1 and a.provider_id = 'credential'`,
    [OWNER],
  );
  return rows.map((row) => row.password);
}

async function sessionCount() {
  const { rows } = await client.query(`select count(*)::int as n from session`);
  return rows[0].n;
}

before(async () => {
  await client.connect();
  await client.query(
    `insert into "user" (id, name, email, email_verified) values ('u1', 'Owner', $1, true)`,
    [OWNER],
  );
  await client.query(
    `insert into account (id, account_id, provider_id, user_id, password)
     values ('a1', 'u1', 'credential', 'u1', $1)`,
    [await hashPassword("the-old-password")],
  );
  for (const id of ["s1", "s2"])
    await client.query(
      `insert into session (id, expires_at, token, user_id) values ($1, now() + interval '1 day', $1, 'u1')`,
      [id],
    );
});

after(() => client.end());

test("refuses to run without the owner's email", async () => {
  const result = reset([], "a-new-password-1\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Give the owner's email/);
  assert.ok(await verifyPassword({ hash: (await storedHash())[0], password: "the-old-password" }));
});

test("refuses an email that isn't the owner's", async () => {
  const result = reset(["someone@example.com"], "a-new-password-1\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /isn't the owner's email/);
  assert.equal(await sessionCount(), 2);
});

test("refuses when the server's owner isn't configured", async () => {
  const result = reset([OWNER], "a-new-password-1\n", { OWNER_EMAIL: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_EMAIL isn't set/);
});

test("refuses a password shorter than sign-in allows", async () => {
  const result = reset([OWNER], "short\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 10 characters/);
  assert.ok(await verifyPassword({ hash: (await storedHash())[0], password: "the-old-password" }));
});

test("sets the new password and signs out every session", async () => {
  const result = reset([OWNER.toUpperCase()], "a-new-password-1\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Signed out 2 sessions/);
  const hashes = await storedHash();
  assert.equal(hashes.length, 1);
  assert.ok(await verifyPassword({ hash: hashes[0], password: "a-new-password-1" }));
  assert.ok(!(await verifyPassword({ hash: hashes[0], password: "the-old-password" })));
  assert.equal(await sessionCount(), 0);
});

test("gives a passkey-only owner a password", async () => {
  await client.query(`delete from account where user_id = 'u1'`);
  const result = reset([OWNER], "another-password-2\n");
  assert.equal(result.status, 0, result.stderr);
  const hashes = await storedHash();
  assert.equal(hashes.length, 1);
  assert.ok(await verifyPassword({ hash: hashes[0], password: "another-password-2" }));
});
