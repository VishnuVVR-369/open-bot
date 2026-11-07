import pg from "pg";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";

const worker = process.env.SLEEP_TEST_WORKER_URL!;
const computer = process.env.SLEEP_TEST_COMPUTER_URL!;
assert(worker && computer, "Only run with disposable sleep-test infrastructure");
const headers = {
  "content-type": "application/json",
  "x-worker-secret": "sleep-test-worker-secret-20261107",
};
const botdHeaders = {
  "content-type": "application/json",
  authorization: "Bearer sleep-test-only-token-20261107",
};
interface SmokeResponse {
  computer: { lifecycle: { phase: string; error: string | null } };
  codex: { account: unknown; stale: boolean };
  egress: { computerConnected: boolean };
  chatId: string;
  workspaceSynced: boolean;
  botId: string;
  dataBase64: string;
  ok: boolean;
  text: string;
}
async function call(
  path: string,
  body?: unknown,
  botd = false,
  method?: string,
): Promise<SmokeResponse> {
  const response = await fetch(`${botd ? computer : worker}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: botd ? botdHeaders : headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  });
  const result = await response.json();
  assert(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result as SmokeResponse;
}
async function until(check: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const status = () => call("/internal/status");
const idle = () =>
  until(async () => (await status()).computer.lifecycle.phase === "idle", "worker idle");
const result: Record<string, unknown> = {
  started: new Date().toISOString(),
  cycles: [],
  memory: [],
  assertions: [],
};
const memory = (label: string) => {
  const name = process.env.SLEEP_TEST_CONTAINER;
  if (!name) return;
  const output = execFileSync(
    "docker",
    [
      "exec",
      name,
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.current; ps -eo rss=,comm= | awk '{s+=$1;n++} END {print s,n}'",
    ],
    { encoding: "utf8" },
  ).trim();
  (result.memory as unknown[]).push({ label, cgroupBytesAndRssKiBAndProcesses: output });
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/openbot_sleep_test");
const modelInputs: string[] = [];
let seenCookie = "";
const fixture = http.createServer((request, response) => {
  if (request.url?.startsWith("/model")) {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      if (request.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
      modelInputs.push(body.toString("utf8"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const id = `resp_sleep_${modelInputs.length}`;
      send("response.created", { response: { id } });
      send("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          id: `msg_${id}`,
          content: [{ type: "output_text", text: `Sleep fixture reply ${modelInputs.length}` }],
        },
      });
      send("response.completed", {
        response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
      });
      response.end();
    });
    return;
  }
  seenCookie = request.headers.cookie ?? "";
  if (request.url === "/seed")
    response.setHeader(
      "set-cookie",
      "sleep_session=persisted; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax",
    );
  response.setHeader("content-type", "text/html");
  response.end(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Persistence fixture</title><body>Sleep persistence fixture<script>${request.url === "/seed" ? 'localStorage.setItem("sleep", "persisted");' : ""}document.body.textContent = "storage=" + localStorage.getItem("sleep") + "; cookie=" + ${JSON.stringify(request.headers.cookie ?? "")};</script>`,
  );
});
await new Promise<void>((resolve) =>
  fixture.listen(Number(process.env.SLEEP_TEST_FIXTURE_PORT ?? 0), "0.0.0.0", resolve),
);
const site = `http://host.docker.internal:${(fixture.address() as AddressInfo).port}`;
try {
  await idle();
  memory("idle initial");
  const bot = await call("/internal/bots", { name: "Sleep fixture", role: "test assistant" });
  assert.equal(bot.workspaceSynced, false);
  assert.equal((await status()).computer.lifecycle.phase, "idle");
  const botId = bot.botId;
  const run = { runId: randomUUID(), botId, botName: "Sleep fixture" };
  const action = (url: string) =>
    call("/computer/action", { run, action: { action: "open_url", url } }, true);
  await call("/internal/egress/mode", { mode: "off" });
  assert.equal((await status()).computer.lifecycle.phase, "idle");
  const file = "/home/bot/shared/sleep-persistence.txt";
  const dataBase64 = Buffer.from("persistent file across sleep and wake").toString("base64");
  await Promise.all([call("/internal/files/list"), call("/internal/files/list")]);
  await call("/internal/files/write", { path: file, dataBase64 });
  memory("zero screens awake");
  await call(`/internal/screens/${botId}/wake`, {});
  assert.equal((await action(`${site}/seed`)).ok, true);
  await call("/lease/run/release", { runId: run.runId }, true);
  memory("one screen");
  await idle();
  const cached = await status();
  assert(cached.codex.account, "intentional idle retains account");
  assert.equal(cached.codex.stale, true);
  assert.equal(cached.egress.computerConnected, false);
  memory("quiesced");
  for (let cycle = 1; cycle <= Number(process.env.SLEEP_TEST_CYCLES ?? 20); cycle++) {
    const began = performance.now();
    await call(`/internal/screens/${botId}/wake`, {});
    const browserReadyMs = performance.now() - began;
    assert.equal(
      (await call(`/internal/files/read?path=${encodeURIComponent(file)}`)).dataBase64,
      dataBase64,
    );
    assert.equal((await action(`${site}/verify`)).ok, true);
    const content = await call("/computer/read", { run }, true);
    assert.equal(content.ok, true);
    assert.match(content.text, /storage=persisted/);
    assert(seenCookie.includes("sleep_session=persisted"), "browser cookie survived");
    await call("/lease/run/release", { runId: run.runId }, true);
    await idle();
    (result.cycles as unknown[]).push({
      cycle,
      browserReadyMs: Math.round(browserReadyMs),
      totalCycleMs: Math.round(performance.now() - began),
    });
    if (cycle % 5 === 0) memory(`after ${cycle} cycles`);
    process.stdout.write(
      `cycle ${cycle}: browser ready ${Math.round(browserReadyMs)}ms; file, cookie and storage persisted\n`,
    );
  }
  if (process.env.SLEEP_TEST_RESOURCE_CHECKS) {
    const second = await call("/internal/bots", {
      name: "Second sleep fixture",
      role: "test assistant",
    });
    const third = await call("/internal/bots", {
      name: "Third sleep fixture",
      role: "test assistant",
    });
    await Promise.all([
      call(`/internal/screens/${botId}/wake`, {}),
      call(`/internal/screens/${second.botId}/wake`, {}),
    ]);
    await call("/lease/user/take", { screenId: botId }, true);
    await call("/lease/user/take", { screenId: second.botId }, true);
    memory("two leased screens");
    const queued = new AbortController();
    const thirdStart = fetch(`${worker}/internal/screens/${third.botId}/wake`, {
      method: "POST",
      headers,
      body: "{}",
      signal: queued.signal,
    });
    const rejected = thirdStart.catch(() => null);
    await delay(200);
    queued.abort();
    await rejected;
    await delay(200);
    const health = (await call("/health", undefined, true)) as unknown as {
      screens: { id: string; state: string }[];
    };
    assert.equal(health.screens.filter((s) => s.state === "running").length, 2);
    assert(!health.screens.some((s) => s.id === third.botId));
    const path = "/home/bot/shared/sleep-check.html";
    await call("/internal/files/write", {
      path,
      dataBase64: Buffer.from(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Sleep check</title></head><body><h1>Independent page checking</h1><p>This page checks a browser while both screens remain available.</p></body></html>',
      ).toString("base64"),
    });
    const checks = Promise.all([
      call("/pages/check", { path }, true),
      call("/pages/check", { path }, true),
    ]);
    await delay(1_000);
    memory("two screens plus page checker");
    for (const checked of await checks) assert.equal(checked.ok, true);
    await call("/lease/user/release", { screenId: botId }, true);
    await call("/lease/user/release", { screenId: second.botId }, true);
    await idle();
    (result.assertions as string[]).push(
      "two leased screens plus one page checker",
      "third-screen cancellation leaves existing screens intact",
    );
  }
  if (process.env.SLEEP_TEST_FIXTURE_PORT) {
    async function sendMessage(text: string) {
      const id = randomUUID();
      await pool.query("insert into messages (id,chat_id,role,text) values ($1,$2,'user',$3)", [
        id,
        bot.chatId,
        text,
      ]);
      await call(`/internal/messages/${id}/dispatch`, {});
      let completed: { status: string; codex_thread_id: string; error: string | null } | undefined;
      await until(
        async () => {
          completed = (
            await pool.query("select status,codex_thread_id,error from runs where message_id=$1", [
              id,
            ])
          ).rows[0];
          if (completed?.status === "failed") throw new Error(`Run failed: ${completed.error}`);
          return completed?.status === "completed";
        },
        "model run completes",
        60_000,
      );
      return completed!;
    }
    const first = await sendMessage("Remember fixture token jellyfish. Reply briefly.");
    await idle();
    const second = await sendMessage("What fixture token did I give you?");
    assert.equal(
      second.codex_thread_id,
      first.codex_thread_id,
      "conversation resumes saved thread",
    );
    assert(
      modelInputs.at(-1)?.includes("jellyfish"),
      "resumed model input contains previous conversation",
    );
    await idle();
    const schedule = randomUUID(),
      due = new Date(Date.now() + 2_000);
    await pool.query(
      "insert into schedules (id,bot_id,title,prompt,kind,run_at,next_run_at,timezone,created_by) values ($1,$2,'Sleep schedule','Reply once for this test','once',$3,$3,'UTC','user')",
      [schedule, botId, due],
    );
    await until(
      async () => {
        const run = (
          await pool.query("select status,error from runs where schedule_id=$1", [schedule])
        ).rows[0];
        if (run?.status === "failed") throw new Error(`Scheduled run failed: ${run.error}`);
        return run?.status === "completed";
      },
      "scheduler wakes idle computer",
      60_000,
    );
    await delay(11_000);
    assert.equal(
      (await pool.query("select count(*)::int as count from runs where schedule_id=$1", [schedule]))
        .rows[0].count,
      1,
    );
    await idle();
    (result.assertions as string[]).push(
      "conversation thread and prior messages resume after restart",
      "scheduler wakes idle computer and runs exactly once",
    );
  }
  assert.equal((await status()).computer.lifecycle.error, null);
  (result.assertions as string[]).push(
    `${process.env.SLEEP_TEST_CYCLES ?? 20} application quiesce/wake cycles`,
    "concurrent wake",
    "file persistence",
    "HttpOnly cookie persistence",
    "localStorage persistence",
    "cached account retained",
    "computer transports disconnected",
    "idle status and bot edits do not wake",
  );
  const values = (result.cycles as { browserReadyMs: number }[])
    .map((c) => c.browserReadyMs)
    .sort((a, b) => a - b);
  result.browserReadyP95Ms = values[Math.ceil(values.length * 0.95) - 1];
  result.finished = new Date().toISOString();
} finally {
  await pool.end();
  fixture.closeAllConnections();
  fixture.close();
  await writeFile(
    process.env.SLEEP_TEST_REPORT ?? "/tmp/openbot-sleep-smoke.json",
    JSON.stringify(result, null, 2),
  );
}
