// Specs that change app-wide state must leave it as it was, even when two runs share one app
// (e2e/shared-state.ts). Runs against TEST_DATABASE_URL, in a schema of its own, from
// scripts/test/integration.sh.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { savePlanSettings, suiteLock } from "../../e2e/shared-state.ts";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "e2e_shared_state_test";
/** Two runs of the e2e suite: each its own pool, like two Playwright processes. */
const pools = [];
const runPool = () => {
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
  pools.push(pool);
  return pool;
};

const OWNER_KEY = { kind: "openai_api_key", encrypted: "owner-ciphertext", hint: "sk-…aaaa" };
const setKey = (pool, key) =>
  pool.query(
    "insert into credentials (kind, encrypted, hint) values ($1, $2, $3) on conflict (kind) do update set encrypted = excluded.encrypted, hint = excluded.hint",
    [key.kind, key.encrypted, key.hint],
  );
const testKey = (hint) => ({ kind: "openai_api_key", encrypted: `test ${hint}`, hint });
const keyNow = async (pool) =>
  (await pool.query("select encrypted, hint from credentials where kind = 'openai_api_key'"))
    .rows[0];
const capNow = async (pool) =>
  Number(
    (await pool.query("select monthly_cap_micros from settings where id = 1")).rows[0]
      .monthly_cap_micros,
  );

/** Resolves once some session waits for an advisory lock: a run queued behind another. */
async function someoneWaits(pool) {
  for (;;) {
    const { rows } = await pool.query(
      "select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted",
    );
    if (rows[0].waiting > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("e2e shared state", { skip: !url && "Set TEST_DATABASE_URL." }, () => {
  let admin;
  before(async () => {
    admin = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    await admin.query(
      `create table ${SCHEMA}.settings (id integer primary key, plan_limited_until timestamptz, monthly_cap_micros bigint not null)`,
    );
    await admin.query(
      `create table ${SCHEMA}.credentials (kind text primary key, encrypted text not null, hint text not null, created_at timestamptz not null default now())`,
    );
  });
  beforeEach(async () => {
    await admin.query(`delete from ${SCHEMA}.credentials`);
    await admin.query(`delete from ${SCHEMA}.settings`);
    await admin.query(
      `insert into ${SCHEMA}.settings (id, plan_limited_until, monthly_cap_micros) values (1, null, 20000000)`,
    );
    await admin.query(
      `insert into ${SCHEMA}.credentials (kind, encrypted, hint) values ($1, $2, $3)`,
      [OWNER_KEY.kind, OWNER_KEY.encrypted, OWNER_KEY.hint],
    );
  });
  after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.end();
  });

  it("puts back your key and settings", async () => {
    const run = runPool();
    const restore = await savePlanSettings(run, "sk-…1234");
    await setKey(run, testKey("sk-…1234"));
    await run.query("update settings set monthly_cap_micros = 0");
    await restore();
    assert.deepEqual(await keyNow(run), {
      encrypted: OWNER_KEY.encrypted,
      hint: OWNER_KEY.hint,
    });
    assert.equal(await capNow(run), 20_000_000);
  });

  it("keeps a key you save while the spec runs", async () => {
    const run = runPool();
    const restore = await savePlanSettings(run, "sk-…1234");
    await setKey(run, testKey("sk-…1234"));
    await setKey(admin, { ...OWNER_KEY, encrypted: "new-owner-ciphertext", hint: "sk-…bbbb" });
    await restore();
    assert.equal((await keyNow(run)).hint, "sk-…bbbb");
  });

  it("two runs take turns, so neither puts back the other's key", async () => {
    const [first, second] = [runPool(), runPool()];
    const restoreFirst = await savePlanSettings(first, "sk-…1234");
    await setKey(first, testKey("sk-…1234"));
    await first.query("update settings set monthly_cap_micros = 5000000");
    // The second run waits for the first to finish before it notes anything.
    let secondSaved = false;
    const second$ = savePlanSettings(second, "sk-…0001").then((restore) => {
      secondSaved = true;
      return restore;
    });
    await someoneWaits(admin);
    assert.equal(secondSaved, false);
    await restoreFirst();
    const restoreSecond = await second$;
    await setKey(second, testKey("sk-…0001"));
    await restoreSecond();
    assert.equal((await keyNow(admin)).hint, OWNER_KEY.hint);
    assert.equal(await capNow(admin), 20_000_000);
  });

  it("a second run doesn't get a suite's lock while the first holds it", async () => {
    const [first, second] = [runPool(), runPool()];
    const release = await suiteLock(first, "accounts", { wait: false });
    assert.ok(release);
    assert.equal(await suiteLock(second, "accounts", { wait: false }), null);
    await release();
    const again = await suiteLock(second, "accounts", { wait: false });
    assert.ok(again);
    await again();
  });
});
