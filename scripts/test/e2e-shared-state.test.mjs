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

  const PLAN = { keyHint: "sk-…e2e1", caps: [5_000_000, 0] };

  it("puts back your key and settings", async () => {
    const run = runPool();
    const restore = await savePlanSettings(run, PLAN);
    await setKey(run, testKey("sk-…e2e1"));
    await run.query("update settings set monthly_cap_micros = 0");
    await restore();
    assert.deepEqual(await keyNow(run), {
      encrypted: OWNER_KEY.encrypted,
      hint: OWNER_KEY.hint,
    });
    assert.equal(await capNow(run), 20_000_000);
  });

  it("keeps a key or a cap you save while the spec runs", async () => {
    const run = runPool();
    const restore = await savePlanSettings(run, PLAN);
    await setKey(run, testKey("sk-…e2e1"));
    await run.query("update settings set monthly_cap_micros = 0");
    await setKey(admin, { ...OWNER_KEY, encrypted: "new-owner-ciphertext", hint: "sk-…bbbb" });
    await admin.query("update settings set monthly_cap_micros = 7000000");
    await restore();
    assert.equal((await keyNow(run)).hint, "sk-…bbbb");
    assert.equal(await capNow(run), 7_000_000);
  });

  it("leaves a key you remove while the spec runs removed", async () => {
    const run = runPool();
    const restore = await savePlanSettings(run, PLAN);
    await setKey(run, testKey("sk-…e2e1"));
    await admin.query("delete from credentials where kind = 'openai_api_key'");
    await restore();
    assert.equal(await keyNow(run), undefined);
  });

  it("refuses a second run while the first holds the settings, so it can't note the first's", async () => {
    const [first, second] = [runPool(), runPool()];
    const restoreFirst = await savePlanSettings(first, PLAN);
    await setKey(first, testKey("sk-…e2e1"));
    assert.equal(await savePlanSettings(second, { ...PLAN, keyHint: "sk-…e2e2" }), null);
    await restoreFirst();
    assert.equal((await keyNow(admin)).hint, OWNER_KEY.hint);
    const restoreSecond = await savePlanSettings(second, { ...PLAN, keyHint: "sk-…e2e2" });
    assert.ok(restoreSecond);
    await restoreSecond();
  });

  it("gives a suite's lock to one run at a time", async () => {
    const [first, second] = [runPool(), runPool()];
    const release = await suiteLock(first, "accounts");
    assert.ok(release);
    assert.equal(await suiteLock(second, "accounts"), null);
    await release();
    const again = await suiteLock(second, "accounts");
    assert.ok(again);
    await again();
  });
});
