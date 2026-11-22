// A long run's progress pushes, end to end (scripts/test/run-progress.sh): a real run on a real
// computer, driven by a stand-in model, sends its pushes to a stand-in FCM. The run works on a long
// command, waits on an approval, works again and ends. With RUN_PROGRESS_RELAY (an agent-device
// command, like `agent-device open dev.openbot.mobile.dev`), each push is also shown on a
// development build of the phone app that has EXPO_PUBLIC_E2E_NOTIFICATIONS=1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import pg from "pg";

const worker = process.env.PROGRESS_TEST_WORKER_URL!;
assert(worker, "Only run with disposable run-progress test infrastructure");
const headers = {
  "content-type": "application/json",
  "x-worker-secret": "progress-test-worker-secret-20261122",
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/openbot_progress_test");

interface Push {
  at: number;
  data: Record<string, string>;
  android: { priority: string; ttl: string; collapse_key?: string };
}
const pushes: Push[] = [];

/** More steps of searching, to leave time to look at the phone while the run works. */
const EXTRA_STEPS = Number(process.env.RUN_PROGRESS_EXTRA_STEPS ?? 0);
/** What the stand-in model does at each step of the turn, by how many tool calls came back. */
const STEPS = [
  `const found = await tools.exec_command({ cmd: "sleep 24; echo 3 nonstop flights", yield_time_ms: 30000 });\ntext(JSON.stringify(found));`,
  ...Array.from(
    { length: EXTRA_STEPS },
    () =>
      `const fares = await tools.exec_command({ cmd: "sleep 25; echo fares checked", yield_time_ms: 30000 });\ntext(JSON.stringify(fares));`,
  ),
  `text(JSON.stringify(await tools.request_approval({ action: "Book the 9:40 flight to Lisbon", details: "TAP TP1351 on Friday, 184 EUR" })));`,
  `const booked = await tools.exec_command({ cmd: "sleep 17; echo booked", yield_time_ms: 30000 });\ntext(JSON.stringify(booked));`,
];
const REPLY = "Booked the 9:40 flight to Lisbon.";

const relay = process.env.RUN_PROGRESS_RELAY?.trim().split(/\s+/);
let relaying: Promise<unknown> = Promise.resolve();
/** Shows a push on the phone, in the order they came, as FCM would hand it to the app. */
function show(data: Record<string, string>) {
  if (!relay) return;
  const link = `openbot:///?e2ePush=${encodeURIComponent(JSON.stringify(data))}`;
  relaying = relaying
    .then(() => promisify(execFile)(relay[0]!, [...relay.slice(1), link]))
    .catch((error: unknown) => console.warn("relay failed", error));
}

const fixture = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    if (request.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
    if (request.url === "/token") {
      response.end(JSON.stringify({ access_token: "progress-access", expires_in: 3600 }));
      return;
    }
    if (request.url === "/fcm/v1/projects/open-bot-progress-test/messages:send") {
      const { message } = JSON.parse(body.toString("utf8")) as { message: Push };
      pushes.push({ at: Date.now(), data: message.data, android: message.android });
      show(message.data);
      response.end(JSON.stringify({ name: "projects/open-bot-progress-test/messages/1" }));
      return;
    }
    if (request.url?.startsWith("/model")) {
      const input = (JSON.parse(body.toString("utf8")) as { input: { type: string }[] }).input;
      const done = input.filter((item) => item.type === "custom_tool_call_output").length;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const id = `resp_${randomUUID()}`;
      send("response.created", { response: { id } });
      const step = STEPS[done];
      send("response.output_item.done", {
        output_index: 0,
        item: step
          ? {
              type: "custom_tool_call",
              id: `ctc_${id}`,
              call_id: `call_${id}`,
              name: "exec",
              input: step,
            }
          : {
              type: "message",
              role: "assistant",
              id: `msg_${id}`,
              content: [{ type: "output_text", text: REPLY }],
            },
      });
      send("response.completed", {
        response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
      });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
});
await new Promise<void>((resolve) =>
  fixture.listen(Number(process.env.PROGRESS_TEST_FIXTURE_PORT), "0.0.0.0", resolve),
);

async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}

const report: Record<string, unknown> = { started: new Date().toISOString() };
try {
  await pool.query(
    "insert into native_push_devices (token, platform, device) values ('phone-1', 'android', 'Stand-in phone')",
  );
  const created = await fetch(`${worker}/internal/teammates`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Rex", role: "travel planner" }),
  });
  assert(created.ok, await created.clone().text());
  const teammate = (await created.json()) as { teammateId: string; chatId: string };
  await pool.query("update chats set title = 'Lisbon trip', titled = true where id = $1", [
    teammate.chatId,
  ]);
  const messageId = randomUUID();
  await pool.query("insert into messages (id,chat_id,role,text) values ($1,$2,'user',$3)", [
    messageId,
    teammate.chatId,
    "Book me the 9:40 nonstop to Lisbon on Friday",
  ]);
  await fetch(`${worker}/internal/messages/${messageId}/dispatch`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const run = await until(async () => {
    const row = (
      await pool.query<{ id: string; started_at: Date | null }>(
        "select id, started_at from runs where message_id = $1",
        [messageId],
      )
    ).rows[0];
    return row?.started_at ? row : undefined;
  }, "run starts");
  console.log(`run ${run.id} started`);

  // Approve the approval the run asks for, once it has asked.
  const approval = await until(async () => {
    const row = (
      await pool.query<{ id: string; created_at: Date }>(
        "select id, created_at from approvals where run_id = $1 and status = 'pending'",
        [run.id],
      )
    ).rows[0];
    return row;
  }, "the run asks for approval");
  console.log(`approval ${approval.id} asked`);
  // Long enough for the phone to show the wait.
  await delay(Number(process.env.RUN_PROGRESS_WAIT_MS ?? 6_000));
  const decided = await fetch(`${worker}/internal/approvals/${approval.id}/decide`, {
    method: "POST",
    headers,
    body: JSON.stringify({ decision: "approved" }),
  });
  assert(decided.ok, await decided.clone().text());
  const decidedAt = Date.now();

  const finished = await until(async () => {
    const row = (
      await pool.query<{ status: string; error: string | null; completed_at: Date | null }>(
        "select status, error, completed_at from runs where id = $1",
        [run.id],
      )
    ).rows[0];
    if (row?.status === "failed") throw new Error(`Run failed: ${row.error}`);
    return row?.status === "completed" ? row : undefined;
  }, "the run completes");
  // The end goes after the run's last write; give it and a stray late update time to arrive.
  await delay(5_000);
  await relaying;

  const progress = pushes.filter((push) => push.data.type === "run-progress");
  const started = run.started_at!.getTime();
  report.pushes = pushes.map((push) => ({
    afterStartMs: push.at - started,
    priority: push.android.priority,
    collapseKey: push.android.collapse_key,
    ...push.data,
  }));

  // Every progress message: normal priority and the run's tag. Updates collapse into the run's
  // latest; the end has no collapse key, so FCM never drops it for another.
  for (const push of progress) {
    assert.equal(push.android.priority, "NORMAL");
    assert.equal(
      push.android.collapse_key,
      push.data.runState === "ended" ? undefined : `run-progress-${run.id}`,
    );
    assert.equal(push.data.tag, `run-progress:${run.id}`);
  }
  // The run's commands (`sleep 24; echo 3 nonstop flights`) never leave the worker, and nor does
  // the chat's title (the teammate wrote it): every word is fixed but the teammate's name.
  assert(!/sleep|nonstop|fares|booked/.test(JSON.stringify(progress)), "a command reached a push");
  assert(!/Lisbon/.test(JSON.stringify(progress)), "the chat's title reached a push");
  // Nothing in the first 20 seconds, then the step the run is on.
  const [first] = progress;
  assert(first, "no progress was sent");
  assert(first.at - started >= 19_500, `first progress after ${first.at - started}ms`);
  assert.equal(first.data.runState, "working");
  assert.equal(first.data.title, "Rex is working");
  assert.equal(first.data.body, "Running a command");
  assert.equal(first.data.url, `/chats/${teammate.chatId}?run=${run.id}`);
  // The wait, within a couple of seconds of the approval being asked, next to the approval itself.
  const waiting = progress.find((push) => push.data.runState === "waiting");
  assert(waiting, "the wait was not sent");
  assert.equal(waiting.data.title, "Rex is waiting for you");
  assert.equal(waiting.data.body, "Waiting for your approval");
  assert(waiting.at - approval.created_at.getTime() < 4_000, "the wait came late");
  const asked = pushes.find((push) => push.data.kind === "approval");
  assert.equal(asked?.android.priority, "HIGH");
  const dismissed = pushes.find((push) => push.data.type === "dismiss");
  assert.equal(dismissed?.data.tag, approval.id);
  assert.equal(dismissed?.android.priority, "NORMAL");
  // Working again after the decision.
  assert(
    progress.some((push) => push.data.runState === "working" && push.at > decidedAt),
    "no update after the decision",
  );
  // The end is the run's last progress message, and the result is its own notification. An update
  // already being sent when the run ends may reach FCM after it: the phone orders them by `sentAt`.
  const stamped = [...progress].sort((a, b) => a.data.sentAt!.localeCompare(b.data.sentAt!));
  const last = stamped.at(-1)!;
  assert.equal(last.data.runState, "ended");
  assert.deepEqual(Object.keys(last.data).sort(), ["runId", "runState", "sentAt", "tag", "type"]);
  assert(last.at >= finished.completed_at!.getTime());
  assert.equal(progress.filter((push) => push.data.runState === "ended").length, 1);
  const sentAt = progress.map((push) => push.data.sentAt!);
  assert.equal(new Set(sentAt).size, sentAt.length, "every message has its own time");
  const updates = progress.filter((push) => push.data.runState !== "ended");
  const updateTimes = updates.map((push) => push.data.sentAt!);
  assert.deepEqual(updateTimes, [...updateTimes].sort(), "a run's updates are sent one at a time");
  const result = pushes.find((push) => push.data.kind === "run_finished");
  assert.equal(result?.data.tag, run.id);
  assert.equal(result?.android.priority, "HIGH");
  // At most one step update per 15 seconds while working.
  const working = progress.filter((push) => push.data.runState === "working");
  for (let i = 1; i < working.length; i++) {
    const gap = working[i]!.at - working[i - 1]!.at;
    const changed = progress.slice(
      progress.indexOf(working[i - 1]!),
      progress.indexOf(working[i]!),
    );
    if (changed.every((push) => push.data.runState === "working"))
      assert(gap >= 14_500, `two step updates ${gap}ms apart`);
  }
  report.result = "passed";
  console.log(
    progress
      .map(
        (push) =>
          `${Math.round((push.at - started) / 1000)}s ${push.data.runState} ${push.data.body ?? ""}`,
      )
      .join("\n"),
  );
} finally {
  report.finished = new Date().toISOString();
  await writeFile(
    process.env.PROGRESS_TEST_REPORT ?? "/tmp/openbot-progress-smoke.json",
    JSON.stringify(report, null, 2),
  );
  await pool.end();
  fixture.closeAllConnections();
  fixture.close();
}
