// The phone app against the local stack: real Android UI and RPC, only the FCM transport injected.
// Needs the local web app and database, an emulator or phone with the dev build, Maestro, and
// E2E_EMAIL + E2E_PASSWORD for the local owner. See the openbot-mobile skill.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Real Android UI and RPC against the local stack; only the FCM transport is injected. */
const root = fileURLToPath(new URL("../../", import.meta.url));
const appUrl = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const databaseUrl =
  process.env.MOBILE_E2E_DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot";
const local = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
if (!local(appUrl) || !local(databaseUrl))
  throw new Error("Phone UI fixtures must use a local app and database.");
const email = process.env.E2E_EMAIL ?? process.env.OWNER_EMAIL;
const password = process.env.E2E_PASSWORD;
if (!email || !password) throw new Error("Set E2E_EMAIL and E2E_PASSWORD for the local owner.");
const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const teammateId = randomUUID();
const chatId = randomUUID();
const runId = randomUUID();
const approvals = Object.fromEntries(
  ["inApp", "live", "shade", "stale", "purchase", "background"].map((key) => [key, randomUUID()]),
);
let server;
let child;
let interrupted = false;
let finishManual;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    child?.kill(signal);
    finishManual?.();
  });

function execute(command, args) {
  if (interrupted) throw new Error("Phone tests interrupted.");
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      child = null;
      if (code === 0) resolve();
      else reject(new Error(`${command} ended with ${signal ?? code}`));
    });
  });
}

try {
  const signIn = await fetch(`${appUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) throw new Error(`Local owner sign-in failed: ${signIn.status}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

  await db.query(
    `insert into bots(id,name,slug,role,instructions,color)
     values($1,$2,$3,'phone test assistant',$4,'#42a5f5')`,
    [
      teammateId,
      `Phone${randomUUID().slice(0, 4)}`,
      `mobile-e2e-${teammateId}`,
      "Follow the test prompt exactly. Do not use tools unless explicitly asked.",
    ],
  );
  await db.query("insert into chats(id,kind,title,bot_id) values($1,'direct',$2,$3)", [
    chatId,
    "E2E phone chat",
    teammateId,
  ]);
  await db.query(
    `insert into runs(id,chat_id,bot_id,trigger,prompt,status,completed_at)
     values($1,$2,$3,'user','Mobile UI fixtures','completed',now())`,
    [runId, chatId, teammateId],
  );
  for (const [key, id] of Object.entries(approvals)) {
    await db.query(
      `insert into approvals(id,run_id,bot_id,chat_id,kind,title,detail,payload,item_id)
       values($1,$2,$3,$4,$5,$6,'Local UI test only','{}',$7)`,
      [
        id,
        runId,
        teammateId,
        chatId,
        key === "purchase" ? "purchase" : "command",
        {
          inApp: "E2E in-app approval",
          live: "E2E live approval",
          shade: "E2E shade approval",
          stale: "E2E stale approval",
          purchase: "E2E purchase approval",
          background: "E2E background approval",
        }[key],
        randomUUID(),
      ],
    );
  }
  await db.query("select pg_notify('openbot_app', $1)", [JSON.stringify({ type: "teammates" })]);

  server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    try {
      if (request.method === "GET" && request.url === "/state") {
        const { rows } = await db.query("select id,status from approvals where run_id=$1", [runId]);
        const state = Object.fromEntries(
          Object.entries(approvals).map(([key, id]) => [
            key,
            rows.find((row) => row.id === id)?.status,
          ]),
        );
        const { rows: messages } = await db.query(
          "select count(*)::int as count from messages where chat_id=$1 and text=$2",
          [chatId, "Reply with just MOBILE_INLINE_OK"],
        );
        response.end(JSON.stringify({ ...state, inlineReplies: messages[0].count }));
      } else if (request.method === "POST" && /^\/decide\/(live|stale)$/.test(request.url)) {
        const approvalId = approvals[request.url.split("/").pop()];
        const result = await fetch(`${appUrl}/api/rpc/approvals/decide`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            json: { approvalId, decision: "denied", alwaysAllow: null },
          }),
        });
        response.statusCode = result.status;
        response.end(await result.text());
      } else if (request.method === "POST" && request.url === "/type-reply") {
        // MIUI blocks Maestro's clipboard helper while SystemUI owns the RemoteInput field.
        // Android's regular text input needs no overlay permission for that same focused field.
        const device = process.env.MOBILE_E2E_DEVICE;
        await new Promise((resolve, reject) =>
          execFile(
            "adb",
            [
              ...(device ? ["-s", device] : []),
              "shell",
              "input",
              "text",
              "Reply%swith%sjust%sMOBILE_INLINE_OK",
            ],
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        response.end("{}");
      } else if (request.method === "POST" && request.url === "/finish" && finishManual) {
        response.end("{}");
        finishManual();
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
  const pushLink = (data) => `openbot:///?e2ePush=${encodeURIComponent(JSON.stringify(data))}`;
  const approvalPush = (key, title, biometric = false) =>
    pushLink({
      type: "notification",
      kind: "approval",
      tag: `mobile-e2e-${approvals[key]}`,
      title,
      body: "Local Android notification test",
      approvalId: approvals[key],
      approvalNeedsBiometric: String(biometric),
      botId: teammateId,
      chatId,
      url: `/approvals/${approvals[key]}`,
    });
  const environment = {
    E2E_EMAIL: email,
    E2E_PASSWORD: password,
    FIXTURE_URL: fixtureUrl,
    DEV_CLIENT_URL:
      "exp+open-bot://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081&__expo_disable_fab=1&__expo_disable_onboarding=1",
    CHAT_LINK: `openbot://chats/${chatId}`,
    APPROVAL_LINK: `openbot://approvals/${approvals.inApp}`,
    LIVE_APPROVAL_LINK: `openbot://approvals/${approvals.live}`,
    PURCHASE_APPROVAL_LINK: `openbot://approvals/${approvals.purchase}`,
    BACKGROUND_APPROVAL_LINK: `openbot://approvals/${approvals.background}`,
    APPROVE_PUSH_LINK: approvalPush("shade", "E2E shade approval"),
    STALE_PUSH_LINK: approvalPush("stale", "E2E stale approval"),
    SENSITIVE_PUSH_LINK: approvalPush("purchase", "E2E purchase review", true),
    REPLY_PUSH_LINK: pushLink({
      type: "notification",
      kind: "run_finished",
      tag: `mobile-e2e-reply-${chatId}`,
      title: "E2E teammate reply",
      body: "Reply here without opening the chat",
      botId: teammateId,
      chatId,
      url: `/chats/${chatId}`,
    }),
  };
  const artifacts = path.join(root, "apps/mobile/.maestro-results");
  await mkdir(artifacts, { recursive: true });
  // IDs and links only; credentials stay in the current process.
  await writeFile(
    path.join(artifacts, "fixtures.json"),
    JSON.stringify({ ...environment, E2E_EMAIL: undefined, E2E_PASSWORD: undefined }, null, 2),
  );
  const device = process.env.MOBILE_E2E_DEVICE;
  const adbArgs = device ? ["-s", device] : [];
  for (const port of [Number(new URL(appUrl).port || 3000), 8081])
    await execute("adb", [...adbArgs, "reverse", `tcp:${port}`, `tcp:${port}`]);
  const maestro = process.env.MAESTRO_BIN ?? "maestro";
  let flowError;
  try {
    await execute(maestro, [
      ...(device ? ["--device", device] : []),
      "test",
      ...(process.env.MAESTRO_NO_REINSTALL === "1" ? ["--no-reinstall-driver"] : []),
      "--test-output-dir",
      artifacts,
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      `apps/mobile/maestro/${process.env.MOBILE_E2E_FLOW ?? "pocket-inbox.yaml"}`,
    ]);
  } catch (error) {
    if (process.env.MOBILE_E2E_MANUAL !== "1" || interrupted) throw error;
    flowError = error;
  }
  if (process.env.MOBILE_E2E_MANUAL === "1" && !interrupted) {
    console.log(
      `${flowError ? "Automated flow failed" : "Automated flows passed"}. Keeping fixtures for manual checks at ${fixtureUrl}; POST /finish to clean up.`,
    );
    await new Promise((resolve) => {
      finishManual = resolve;
    });
  }
  if (flowError) throw flowError;
} finally {
  if (child) child.kill("SIGTERM");
  if (server) await new Promise((resolve) => server.close(resolve));
  // Cancel and let the worker finish before deleting fixtures it may still be using.
  await db.query(
    "update runs set cancel_requested_at=now() where bot_id=$1 and status in ('queued','starting','running','waiting')",
    [teammateId],
  );
  const activeRuns = async () =>
    (
      await db.query(
        "select id from runs where bot_id=$1 and status in ('queued','starting','running','waiting')",
        [teammateId],
      )
    ).rowCount;
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:4001";
  const headers = {
    "x-worker-secret": process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
    "content-type": "application/json",
  };
  if (local(workerUrl)) {
    await fetch(`${workerUrl}/internal/runs/cancel`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  for (let attempt = 0; attempt < 25 && (await activeRuns()); attempt++) await delay(200);
  if (await activeRuns()) {
    await db.query("update bots set archived_at=now() where id=$1", [teammateId]);
    console.warn(`Test teammate ${teammateId} was archived while its cancelled run finishes.`);
  } else {
    const botdUrl = process.env.BOTD_URL ?? "http://127.0.0.1:7070";
    if (local(botdUrl))
      await fetch(`${botdUrl}/screens/forget`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.BOTD_TOKEN ?? "dev-botd-token-change-me"}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ screenId: teammateId }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    await db.query("delete from bots where id=$1", [teammateId]);
    if (local(workerUrl))
      await fetch(`${workerUrl}/internal/files/remove`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: `/home/bot/bots/mobile-e2e-${teammateId}` }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
  }
  await db.query("select pg_notify('openbot_app', $1)", [JSON.stringify({ type: "teammates" })]);
  await db.end();
}
