import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

// Real botd/CDP and worker, without a model or production data. Start a disposable stack first.
const databaseUrl = process.env.SCREEN_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_phase2_test"))
  throw new Error("SCREEN_TEST_DATABASE_URL must select a disposable *_phase2_test database.");
const workerUrl = process.env.SCREEN_TEST_WORKER_URL ?? "http://127.0.0.1:4101";
const computerUrl = process.env.SCREEN_TEST_COMPUTER_URL ?? "http://127.0.0.1:17070";
const workerSecret = process.env.SCREEN_TEST_WORKER_SECRET ?? "phase2-local-worker-test-token";
const botdToken = process.env.SCREEN_TEST_BOTD_TOKEN ?? "phase2-local-computer-test-token";
const db = new pg.Pool({ connectionString: databaseUrl });
const id = randomUUID();
let clear = false;
let submit = "clear";
let typed = "";
const buttons = [];
const server = createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/state") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ clear, typed, buttons }));
    return;
  }
  if (request.url === "/input" || request.url === "/pointer") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/input") typed = body;
      else buttons.push(Number(body));
      response.end("ok");
    });
    return;
  }
  if (request.url === "/submit") {
    response.end(submit);
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Code safety fixture</title><style>body{font:28px sans-serif;padding:50px}input,button{font:28px sans-serif}</style><h1>Phase 2 verification</h1><form><label>One-time code <input autofocus id="code"></label><button>Submit</button></form><p id="result"></p><script>
    document.querySelector('form').onsubmit=async e=>{e.preventDefault();const mode=await(await fetch('/submit')).text();const el=document.querySelector('input');if(mode==='clear'){el.value='';document.querySelector('#result').textContent='Verified';}else document.querySelector('#result').textContent='Code: '+el.value;};
    document.querySelector('input').oninput=e=>fetch('/input',{method:'POST',body:e.target.value});
    document.addEventListener('mousedown',e=>fetch('/pointer',{method:'POST',body:String(e.button)}));
    document.addEventListener('contextmenu',e=>e.preventDefault());
    setInterval(async()=>{const state=await(await fetch('/state')).json();if(state.clear){document.querySelector('input').value='';document.querySelector('#result').textContent='Cleared';}},100);
  </script>`);
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const page = `http://host.docker.internal:${server.address().port}`;
async function call(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(base === workerUrl
        ? { "x-worker-secret": workerSecret }
        : { authorization: `Bearer ${botdToken}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function focus() {
  const runId = randomUUID();
  const result = await call(computerUrl, "/computer/action", {
    run: { runId, botId: id, botName: "Code test" },
    action: { action: "open_url", url: page },
  });
  assert.equal(result.ok, true);
  await call(computerUrl, "/lease/run/release", { runId });
  for (let i = 0; i < 30; i++) {
    if ((await call(computerUrl, "/computer/code-context", { screenId: id })).site) return;
    await delay(200);
  }
  throw new Error("The fixture code field did not receive browser focus.");
}
async function request() {
  const takeover = randomUUID();
  await db.query(
    "insert into desktop_takeovers(id,screen_id,status,reason) values($1,$2,'requested','Enter the fixture code')",
    [takeover, id],
  );
  await db.query("select pg_notify('openbot_app', $1)", [JSON.stringify({ type: "takeovers" })]);
  return {
    takeoverId: takeover,
    operationId: randomUUID(),
    expectedSite: "host.docker.internal",
    pressEnter: true,
    text: "582913",
  };
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${computerUrl}/healthz`)).ok) break;
    } catch {
      /* Starting. */
    }
    await delay(100);
  }
  await db.query(
    "insert into bots(id,name,slug,role,instructions,color) values($1::uuid,'Phase 2 Code Test',$1::text,'Fixture','Fixture','#42a5f5')",
    [id],
  );
  await focus();
  const first = await request();
  const success = await call(workerUrl, "/internal/screens/code", first);
  assert.equal(success.status, "handed_back");
  assert.equal((await call(workerUrl, "/internal/screens/code", first)).status, "handed_back");
  console.log(
    "PASS: real CDP verifies a submitted code is gone before hand-back; duplicates do not type.",
  );
  await focus();
  submit = "keep";
  const second = await request();
  assert.equal((await call(workerUrl, "/internal/screens/code", second)).status, "needs_owner");
  const blocked = await call(computerUrl, "/computer/action", {
    run: { runId: randomUUID(), botId: id, botName: "Code test" },
    action: { action: "screenshot" },
  });
  assert.equal(blocked.code, "user_has_control");
  assert.equal((await call(computerUrl, "/lease/user/release", { screenId: id })).released, false);
  assert.equal(
    (await call(computerUrl, "/lease/user/release", { screenId: id, clearCode: true })).released,
    false,
  );
  clear = true;
  await delay(350);
  assert.equal((await call(computerUrl, "/lease/user/release", { screenId: id })).released, true);
  console.log(
    "PASS: code in page text blocks screenshots and both ordinary and clear-only hand-back until safe.",
  );
  const operations = await db.query("select * from screen_operations where screen_id=$1", [id]);
  assert.ok(!JSON.stringify(operations.rows).includes(first.text));
  console.log("PASS: durable operation records contain no submitted code.");
  if (process.env.SCREEN_TEST_UI === "1") {
    clear = false;
    submit = "clear";
    await focus();
    const third = await request();
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.MAESTRO_BIN ?? "maestro",
        [
          "--device",
          process.env.MOBILE_E2E_DEVICE ?? "emulator-5554",
          "test",
          "-e",
          `SCREEN_ID=${id}`,
          "-e",
          `TAKEOVER_ID=${third.takeoverId}`,
          "-e",
          `FIXTURE_URL=http://127.0.0.1:${server.address().port}`,
          "--test-output-dir",
          "apps/mobile/.maestro-results/code-entry",
          "apps/mobile/maestro/code-entry.yaml",
        ],
        { stdio: "inherit", env: process.env },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Code-entry Maestro exited ${code}`)),
      );
    });
    const result = await db.query("select status from screen_operations where takeover_id=$1", [
      third.takeoverId,
    ]);
    assert.equal(result.rows[0]?.status, "handed_back");
    console.log("PASS: emulator code preview, code sheet, submit, and verified hand-back.");
  }
} finally {
  clear = true;
  await delay(200);
  await call(computerUrl, "/lease/user/release", { screenId: id, clearCode: true }).catch(() => {});
  await call(computerUrl, "/screens/forget", { screenId: id }).catch(() => {});
  await db.query("delete from bots where id=$1", [id]);
  await db.end();
  server.close();
}
