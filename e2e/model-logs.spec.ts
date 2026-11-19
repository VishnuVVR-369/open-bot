import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { expect, test } from "./fixtures";
import { e2eStack, uniqueName, uniqueWord } from "./helpers";

const pool = new pg.Pool({ connectionString: e2eStack().databaseUrl });

/** What this spec stored outside its teammate, which teardown can't find: deleted in afterAll. */
const made = { requests: [] as string[], blobs: [] as string[] };

async function blob(value: unknown, kind: "item" | "instructions" | "tools") {
  const content = JSON.stringify(value);
  const hash = createHash("sha256").update(content).digest("hex");
  await pool.query(
    "insert into model_blobs(hash,kind,content,bytes) values($1,$2,$3,$4) on conflict do nothing",
    [hash, kind, content, Buffer.byteLength(content)],
  );
  made.blobs.push(hash);
  return hash;
}

interface Request {
  turnId: string | null;
  kind: "turn" | "prewarm";
  at: Date;
  input: unknown[];
  output: unknown[];
  tokens?: [input: number, output: number];
  calls?: { callId: string; name: string; arguments: string }[];
}

/**
 * A finished run with a reply, and its model logs as the worker writes them: a turn, a prewarm
 * with no turn id, a request that ran a shell command, and the command's started and completed
 * messages, joined to the call by its call id.
 */
async function seedRun(prompt: string, secret: string) {
  const teammateId = randomUUID();
  const chatId = randomUUID();
  const runId = randomUUID();
  const name = uniqueName("Lumen");
  await pool.query(
    "insert into bots(id,name,slug,role,color) values($1,$2,$3,'test assistant','#7C5CFF')", // vocabulary: allow
    [teammateId, name, name.toLowerCase()],
  );
  await pool.query(
    "insert into chats(id,kind,title,bot_id) values($1,'direct','Model logs check',$2)", // vocabulary: allow
    [chatId, teammateId],
  );
  const start = new Date(Date.now() - 5 * 60_000);
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  const reply = "All 12 tests pass.";
  await pool.query(
    "insert into runs(id,chat_id,bot_id,trigger,prompt,status,final_text,created_at,started_at,completed_at) values($1,$2,$3,'user',$4,'completed',$5,$6,$6,$7)", // vocabulary: allow
    [runId, chatId, teammateId, prompt, reply, start, at(20)],
  );
  await pool.query("insert into run_events(run_id,chat_id,payload) values($1,$2,$3)", [
    runId,
    chatId,
    {
      type: "item",
      item: {
        id: `answer-${runId}`,
        kind: "message",
        phase: "final",
        status: "completed",
        startedAt: at(19).toISOString(),
        completedAt: at(20).toISOString(),
        text: reply,
      },
    },
  ]);

  const threadId = randomUUID();
  const turnId = randomUUID();
  await pool.query(
    "insert into run_turns(run_id,codex_thread_id,codex_turn_id,access_mode,started_at) values($1,$2,$3,'plan',$4)",
    [runId, threadId, turnId, at(1)],
  );
  const instructions = await blob(`You are ${name}. ${secret}`, "instructions");
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] };
  const call = {
    type: "function_call",
    call_id: "call_e2e_1",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "pnpm test" }),
  };
  const output = { type: "function_call_output", call_id: "call_e2e_1", output: "12 passed" };
  const answer = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: reply }],
  };
  const requests: Request[] = [
    { turnId: null, kind: "prewarm", at: at(1.2), input: [user], output: [] },
    {
      turnId,
      kind: "turn",
      at: at(2),
      input: [user],
      output: [call],
      tokens: [9_000, 120],
      calls: [{ callId: "call_e2e_1", name: "exec_command", arguments: call.arguments }],
    },
    { turnId, kind: "turn", at: at(12), input: [user, call, output], output: [answer] },
  ];
  for (const request of requests) {
    const id = randomUUID();
    made.requests.push(id);
    await pool.query(
      `insert into model_requests(id,source,route,transport,method,endpoint,codex_thread_id,codex_turn_id,
        request_kind,teammate_id,model,status,started_at,first_byte_at,ended_at,input_tokens,output_tokens,
        request_headers,params,instructions_hash,response_text)
       values($1,'codex','plan','http','POST','/responses',$2,$3,$4,$5,'gpt-5.5',200,$6,$6::timestamptz + interval '400 ms',
        $6::timestamptz + interval '2 s',$7,$8,'{"content-type":"application/json"}',$9,$10,$11)`,
      [
        id,
        threadId,
        request.turnId,
        request.kind,
        teammateId,
        request.at,
        request.tokens?.[0] ?? null,
        request.tokens?.[1] ?? null,
        { model: "gpt-5.5", stream: true },
        instructions,
        request.output.includes(answer) ? reply : null,
      ],
    );
    for (const [side, items] of [
      ["input", request.input],
      ["output", request.output],
    ] as const)
      for (const [position, item] of items.entries())
        await pool.query(
          "insert into model_request_items(request_id,side,position,blob_hash) values($1,$2,$3,$4)",
          [id, side, position, await blob(item, "item")],
        );
    for (const [position, toolCall] of (request.calls ?? []).entries())
      await pool.query(
        "insert into model_tool_calls(request_id,position,call_id,type,name,arguments) values($1,$2,$3,'function_call',$4,$5)",
        [id, position, toolCall.callId, toolCall.name, toolCall.arguments],
      );
  }
  const command = { type: "commandExecution", id: "call_e2e_1", command: "pnpm test", cwd: "/" };
  for (const [sequence, method, when, item] of [
    [1, "item/started", at(4), { ...command, status: "inProgress" }],
    [
      2,
      "item/completed",
      at(9),
      { ...command, status: "completed", exitCode: 0, durationMs: 5000, aggregatedOutput: "ok" },
    ],
  ] as const)
    await pool.query(
      "insert into codex_events(run_id,codex_thread_id,codex_turn_id,item_id,sequence,direction,kind,method,payload,at) values($1,$2,$3,'call_e2e_1',$4,'from_codex','notification',$5,$6,$7)",
      [
        runId,
        threadId,
        turnId,
        Date.now() * 1000 + sequence,
        method,
        { threadId, turnId, item },
        when,
      ],
    );
  return { chatId, runId };
}

test.afterAll(async () => {
  // Turns and Codex messages go with the run, when teardown deletes the teammate; requests and
  // blobs outlive both, so they go here, by the ids this spec made.
  await pool.query("delete from model_requests where id = any($1::uuid[])", [made.requests]);
  await pool.query("delete from model_blobs where hash = any($1::text[])", [made.blobs]);
  await pool.end();
});

test("a reply opens its run's model requests, and a request shows what was sent", async ({
  page,
}) => {
  const prompt = `Run the tests, ${uniqueWord("check")}`;
  const secret = uniqueWord("rule");
  const { chatId, runId } = await seedRun(prompt, secret);
  await page.goto(`/chats/${chatId}`);

  await page.getByText("All 12 tests pass.").hover();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByTestId("inspect-run").click();
  await expect(page).toHaveURL(new RegExp(`/settings/model-logs/runs/${runId}$`));

  // The turn's three requests, the prewarm placed in it by time.
  const requests = page.getByTestId("model-request");
  await expect(requests).toHaveCount(3);
  await expect(requests.nth(0)).toContainText("Prewarm");
  await expect(requests.nth(0)).toContainText("placed here by when it started");
  // The shell call, joined to its command's outcome.
  const call = requests.nth(1).getByTestId("tool-call");
  await expect(call).toContainText("pnpm test");
  await expect(call).toContainText("Exit 0");

  // Expanding a request loads what it sent: the labeled input and the instructions.
  const toggle = requests.nth(2).getByTestId("model-request-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const details = requests.nth(2).getByTestId("model-request-details");
  const labels = details.getByTestId("model-item-label");
  await expect(labels).toHaveText(["User", "Tool call: exec_command", "Tool output"]);
  await expect(details.getByTestId("model-item").first()).toContainText(prompt);
  await details.getByRole("tab", { name: "Instructions" }).click();
  await expect(details).toContainText(secret);
});

test("on a phone, Settings opens with Model logs in view and shows the row scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/model-logs");
  const nav = page.getByRole("navigation", { name: "Settings" });
  const current = nav.getByRole("link", { name: "Model logs" });
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(current).toBeInViewport({ ratio: 1 });
  // The groups before it are past the row's start edge, which fades out to say so.
  await expect(nav.getByRole("list")).toHaveAttribute("data-overflow", "start");
  await expect(nav.getByRole("link", { name: "Account" })).not.toBeInViewport({ ratio: 1 });

  // Back at the start, the fade moves to the other edge.
  await nav.getByRole("list").evaluate((row) => row.scrollTo({ left: 0 }));
  await expect(nav.getByRole("list")).toHaveAttribute("data-overflow", "end");
});
