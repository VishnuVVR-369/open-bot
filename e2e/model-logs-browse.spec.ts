import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { expect, test } from "./fixtures";
import { apiFor, e2eStack, uniqueName, uniqueWord } from "./helpers";
import { suiteLock } from "./shared-state";

const pool = new pg.Pool({ connectionString: e2eStack().databaseUrl });

/** What this spec stored outside its teammate, which teardown can't find: deleted in afterAll. */
const made = { requests: [] as string[], blobs: [] as string[] };

async function blob(value: unknown) {
  const content = JSON.stringify(value);
  const hash = createHash("sha256").update(content).digest("hex");
  await pool.query(
    "insert into model_blobs(hash,kind,content,bytes) values($1,'item',$2,$3) on conflict do nothing",
    [hash, content, Buffer.byteLength(content)],
  );
  made.blobs.push(hash);
  return hash;
}

const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});

/**
 * A teammate's finished run, logged as the worker writes it: two requests in one turn, the first
 * calling a shell command that failed, the second answering with `answer`.
 */
async function seedRun({
  prompt,
  answer,
  command,
}: {
  prompt: string;
  answer: string;
  command: string;
}) {
  const teammateId = randomUUID();
  const chatId = randomUUID();
  const runId = randomUUID();
  const threadId = randomUUID();
  const turnId = randomUUID();
  const name = uniqueName("Quill");
  await pool.query(
    "insert into teammates(id,name,slug,role,color) values($1,$2,$3,'test assistant','#7C5CFF')",
    [teammateId, name, name.toLowerCase()],
  );
  await pool.query(
    "insert into chats(id,kind,title,teammate_id) values($1,'direct','Model log browsing',$2)",
    [chatId, teammateId],
  );
  const start = new Date(Date.now() - 10 * 60_000);
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  await pool.query(
    "insert into runs(id,chat_id,teammate_id,trigger,prompt,status,final_text,created_at,started_at,completed_at) values($1,$2,$3,'user',$4,'completed',$5,$6,$6,$7)",
    [runId, chatId, teammateId, prompt, answer, start, at(30)],
  );
  await pool.query(
    "insert into run_turns(run_id,codex_thread_id,codex_turn_id,access_mode,started_at) values($1,$2,$3,'plan',$4)",
    [runId, threadId, turnId, at(1)],
  );
  const call = {
    type: "function_call",
    call_id: "call_browse_1",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: command }),
  };
  const output = { type: "function_call_output", call_id: "call_browse_1", output: "exit 1" };
  const requests = [
    { at: at(2), input: [message("user", prompt)], output: [call], text: null, tokens: 7_000 },
    {
      at: at(12),
      input: [message("user", prompt), call, output],
      output: [message("assistant", answer)],
      text: answer,
      tokens: 8_000,
    },
  ];
  const ids: string[] = [];
  for (const request of requests) {
    const id = randomUUID();
    ids.push(id);
    made.requests.push(id);
    await pool.query(
      `insert into model_requests(id,source,route,transport,method,endpoint,codex_thread_id,codex_turn_id,
        request_kind,teammate_id,model,status,started_at,first_byte_at,ended_at,input_tokens,output_tokens,
        request_headers,params,response_text)
       values($1,'codex','plan','http','POST','/responses',$2,$3,'turn',$4,'gpt-5.5',200,$5,
        $5::timestamptz + interval '400 ms',$5::timestamptz + interval '2 s',$6,90,
        '{"content-type":"application/json"}','{"model":"gpt-5.5","stream":true}',$7)`,
      [id, threadId, turnId, teammateId, request.at, request.tokens, request.text],
    );
    for (const [side, items] of [
      ["input", request.input],
      ["output", request.output],
    ] as const)
      for (const [position, item] of items.entries())
        await pool.query(
          "insert into model_request_items(request_id,side,position,blob_hash) values($1,$2,$3,$4)",
          [id, side, position, await blob(item)],
        );
  }
  await pool.query(
    "insert into model_tool_calls(request_id,position,call_id,type,name,arguments) values($1,0,'call_browse_1','function_call','exec_command',$2)",
    [ids[0], call.arguments],
  );
  const item = { type: "commandExecution", id: "call_browse_1", command, cwd: "/" };
  for (const [sequence, method, when, payload] of [
    [1, "item/started", at(4), { ...item, status: "inProgress" }],
    [
      2,
      "item/completed",
      at(9),
      { ...item, status: "failed", exitCode: 1, durationMs: 5000, aggregatedOutput: "exit 1" },
    ],
  ] as const)
    await pool.query(
      "insert into codex_events(run_id,codex_thread_id,codex_turn_id,item_id,sequence,direction,kind,method,payload,at) values($1,$2,$3,'call_browse_1',$4,'from_codex','notification',$5,$6,$7)",
      [
        runId,
        threadId,
        turnId,
        Date.now() * 1000 + sequence,
        method,
        { threadId, turnId, item: payload },
        when,
      ],
    );
  return { teammateId, name, runId, requestIds: ids };
}

let seeded: Awaited<ReturnType<typeof seedRun>>;
const words = {
  answer: uniqueWord("heron"),
  command: `pnpm vitest run ${uniqueWord("ledger")}`,
};

test.beforeAll(async () => {
  seeded = await seedRun({
    prompt: "Why is the nightly build red?",
    answer: `The ${words.answer} migration broke the build.`,
    command: words.command,
  });
});

test.afterAll(async () => {
  // Turns and Codex messages go with the run, when teardown deletes the teammate; requests and
  // blobs outlive both, so they go here, by the ids this spec made.
  await pool.query("delete from model_requests where id = any($1::uuid[])", [made.requests]);
  await pool.query("delete from model_blobs where hash = any($1::text[])", [made.blobs]);
  await pool.end();
});

test("search finds a run by what came back, and filters keep to one teammate", async ({ page }) => {
  await page.goto("/settings/model-logs");
  await page.getByTestId("model-logs-search").fill(words.answer);
  await expect(page).toHaveURL(new RegExp(`q=${words.answer}`));
  const rows = page.getByTestId("model-log-run");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(seeded.name);
  await expect(rows.first().getByTestId("model-log-match").locator("mark")).toHaveText(
    words.answer,
  );
  // A word nobody wrote finds nothing.
  await page.getByTestId("model-logs-search").fill(uniqueWord("absent"));
  await expect(page.getByTestId("model-logs-no-match")).toBeVisible();

  // Filtered by teammate, the run is there; the export link takes the chosen dates.
  await page.goto(`/settings/model-logs?teammate=${seeded.teammateId}&range=7d`);
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("export-range")).toHaveText("Export the last 7 days");
  await rows.first().click();
  await expect(page).toHaveURL(new RegExp(`/settings/model-logs/runs/${seeded.runId}$`));
});

test("the Tools tab counts the failed command and links its failure to the run", async ({
  page,
}) => {
  await page.goto(`/settings/model-logs/tools?teammate=${seeded.teammateId}&range=7d`);
  const stat = page.getByTestId("tool-stat").filter({ hasText: "Shell command" });
  await expect(stat).toContainText("1 · 100%");
  const failure = page.getByTestId("tool-failure").filter({ hasText: words.command });
  await expect(failure).toHaveCount(1);
  await expect(failure.getByTestId("failure-certainty")).toContainText("exec_command");
  await failure.getByTestId("failure-run-link").click();
  await expect(page).toHaveURL(new RegExp(`/settings/model-logs/runs/${seeded.runId}$`));
});

test("the Usage tab lists the teammate's requests and tokens", async ({ page }) => {
  await page.goto("/settings/model-logs/usage?range=7d");
  await expect(page.getByTestId("usage-tokens")).toBeVisible();
  const row = page
    .getByTestId("usage-table")
    .first()
    .getByRole("row")
    .filter({ hasText: seeded.name });
  await expect(row).toContainText("2");
  await expect(row).toContainText("15K");
});

test("a run exports as JSONL, one request per line, rebuilt in full", async ({ page }) => {
  await page.goto(`/settings/model-logs/runs/${seeded.runId}`);
  const download = page.waitForEvent("download");
  await page.getByTestId("export-run").click();
  const file = await (await download).path();
  const lines = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines.map((line) => line.id)).toEqual(seeded.requestIds);
  expect(lines[1].run_id).toBe(seeded.runId);
  expect(JSON.stringify(lines[1].request.input)).toContain(words.command);
});

test("the owner chooses how long bodies are kept, after a warning", async ({ page }) => {
  const release = await suiteLock(pool, "model log retention");
  test.skip(!release, "Another run is changing model log retention.");
  const api = apiFor(page);
  const before = (await api.modelLogs.retention()).days;
  try {
    // From forever to a week asks first, since older bodies go for good.
    if (before !== null) await api.modelLogs.setRetention({ days: null });
    await page.goto("/settings/model-logs/retention");
    await expect(page.getByTestId("retention-select")).toHaveText("Forever (default)");
    await page.getByTestId("retention-select").click();
    await page.getByRole("option", { name: "1 week" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Keep bodies for 1 week?");
    await page.getByTestId("retention-confirm").click();
    await expect(page.getByTestId("retention-select")).toHaveText("1 week");
    await expect.poll(async () => (await api.modelLogs.retention()).days).toBe(7);
    // Keeping more never removes anything, so it saves at once.
    await page.getByTestId("retention-select").click();
    await page.getByRole("option", { name: "Forever (default)" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(async () => (await api.modelLogs.retention()).days).toBe(null);
  } finally {
    // Put back what was there, unless the owner changed it meanwhile.
    const now = (await api.modelLogs.retention()).days;
    if (now !== before && (now === null || now === 7))
      await api.modelLogs.setRetention({ days: before });
    await release?.();
  }
});
