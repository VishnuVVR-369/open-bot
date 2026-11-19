import http from "node:http";
import { expect, test } from "./fixtures";
import pg from "pg";
import {
  e2eStack,
  createTeammate,
  savePlanSettings,
  sendMessage,
  testApiKey,
  uniqueName,
  waitForLastRun,
} from "./helpers";

/**
 * Rehearses a real plan limit end to end: the real worker and the real Codex app-server,
 * with only the model endpoints replaced. The "plan" endpoint answers like ChatGPT does when
 * the usage limit is reached, and the "API" endpoint answers normally.
 *
 * The API key's requests go through the worker's model proxy, which logs them, so the worker,
 * not the computer, calls the "API" endpoint. Start the worker with:
 *   OPEN_BOT_PLAN_BASE_URL=http://host.docker.internal:4799/plan
 *   OPENAI_API_BASE_URL=http://127.0.0.1:4799/api
 * then run: E2E_PLAN_REHEARSAL=1 pnpm e2e --grep rehearsal
 */
test.skip(
  !process.env.E2E_PLAN_REHEARSAL,
  "Needs the worker started with the rehearsal endpoints.",
);

const pool = new pg.Pool({
  connectionString: e2eStack().databaseUrl,
});
const requests: string[] = [];
let server: http.Server | undefined;
let restore: (() => Promise<void>) | null = null;

test.beforeAll(async () => {
  restore = await savePlanSettings(pool, { keyHint: testApiKey().hint, caps: [5_000_000] });
  test.skip(!restore, "Another run is testing the plan settings on this app.");
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(req.url ?? "");
      if (req.url?.startsWith("/plan")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              message: "The usage limit has been reached",
              plan_type: "plus",
              resets_in_seconds: 3600,
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("response.created", { response: { id: "resp_rehearsal" } });
      send("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          id: "msg_rehearsal",
          content: [{ type: "output_text", text: "pong from the API key" }],
        },
      });
      send("response.completed", {
        response: {
          id: "resp_rehearsal",
          usage: {
            input_tokens: 12_000,
            input_tokens_details: { cached_tokens: 2_000 },
            output_tokens: 300,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 12_300,
          },
        },
      });
      res.end();
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(4799, "0.0.0.0", resolve));
  await pool.query("update settings set plan_limited_until = null, monthly_cap_micros = 5000000");
});

test.afterAll(async () => {
  await restore?.();
  await pool.end();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
});

test("rehearsal: the plan hits its limit mid-run and the run finishes on the API key", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/settings");
  const key = testApiKey();
  await page.getByLabel("OpenAI API key").fill(key.key);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText(key.hint)).toBeVisible();
  await expect(page.getByTestId("fallback-status")).toContainText("Running on your ChatGPT plan");

  await createTeammate(page, uniqueName("Ava"));
  await sendMessage(page, "Say pong.");
  await waitForLastRun(page, ["completed"], 180_000);
  const run = page.getByTestId("run").last();
  await expect(run).toContainText("pong from the API key");
  await expect(run).toContainText("API key");
  // A finished run folds its steps, the fallback note among them, into "Worked for 4s · 1 step".
  const steps = run.getByTestId("run-steps");
  await expect(steps).toBeVisible();
  if ((await steps.getAttribute("aria-expanded")) === "false") await steps.click();
  await expect(run).toContainText("Your ChatGPT plan hit its limit");
  expect(requests.filter((url) => url.startsWith("/plan")).length).toBeGreaterThan(0);
  expect(requests.filter((url) => url.startsWith("/api")).length).toBeGreaterThan(0);

  // The key's requests went through the model proxy: logged against the run's thread, priced,
  // and stored without the key. The proxy saves its logs in batches, so they land shortly after.
  const logged = () =>
    pool.query<{ status: number; cost_micros: string; response_text: string; headers: string }>(
      `select m.status, m.cost_micros, m.response_text, m.request_headers::text as headers
       from model_requests m join runs r on r.codex_thread_id = m.codex_thread_id
       where m.route = 'api' and r.id = (select id from runs order by created_at desc limit 1)`,
    );
  await expect.poll(async () => (await logged()).rows.length).toBeGreaterThan(0);
  const { rows: requestRows } = await logged();
  expect(requestRows[0]).toMatchObject({
    status: 200,
    cost_micros: "23200",
    response_text: "pong from the API key",
  });
  expect(requestRows.map((row) => row.headers).join()).not.toContain(key.key);

  // The worker remembered the limit, metered the spend, and the next run goes straight to the key.
  const before = requests.length;
  await sendMessage(page, "Say pong again.");
  await waitForLastRun(page, ["completed"], 120_000);
  expect(requests.slice(before).every((url) => url.startsWith("/api"))).toBe(true);

  await page.goto("/settings");
  await expect(page.getByTestId("fallback-status")).toContainText("Running on your API key");
  // Two runs of (10k uncached x $2 + 2k cached x $0.10 + 300 output x $10) per million = $0.0232 each.
  const { rows } = await pool.query(
    "select coalesce(sum(cost_micros), 0)::int as spend from usage_entries where auth_mode = 'api_key' and created_at > now() - interval '10 minutes'",
  );
  expect(rows[0].spend).toBeGreaterThanOrEqual(46_400);
  // The month's total also counts earlier API key runs.
  const month = await pool.query(
    "select coalesce(sum(cost_micros), 0)::int as spend from usage_entries where auth_mode = 'api_key' and created_at >= date_trunc('month', now())",
  );
  const spent = `$${(month.rows[0].spend / 1_000_000).toFixed(2)}`;
  await expect(page.getByText(`${spent} of $5.00`)).toBeVisible();
});
