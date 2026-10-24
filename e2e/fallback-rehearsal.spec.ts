import http from "node:http";
import { expect, test } from "./fixtures";
import pg from "pg";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

/**
 * Rehearses a real plan limit end to end: the real worker and the real Codex app-server,
 * with only the model endpoints replaced. The "plan" endpoint answers like ChatGPT does when
 * the usage limit is reached, and the "API" endpoint answers normally.
 *
 * Start the worker with:
 *   OPEN_BOT_PLAN_BASE_URL=http://host.docker.internal:4799/plan
 *   OPENAI_API_BASE_URL=http://host.docker.internal:4799/api
 * then run: E2E_PLAN_REHEARSAL=1 pnpm e2e --grep rehearsal
 */
test.skip(
  !process.env.E2E_PLAN_REHEARSAL,
  "Needs the worker started with the rehearsal endpoints.",
);

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
});
const requests: string[] = [];
let server: http.Server;

test.beforeAll(async () => {
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
  await new Promise<void>((resolve) => server.listen(4799, "0.0.0.0", resolve));
  await pool.query("update settings set plan_limited_until = null, monthly_cap_micros = 5000000");
});

test.afterAll(async () => {
  await pool.query("update settings set plan_limited_until = null, monthly_cap_micros = 20000000");
  await pool.query("delete from credentials");
  await pool.end();
  await new Promise((resolve) => server.close(resolve));
});

test("rehearsal: the plan hits its limit mid-run and the run finishes on the API key", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/settings");
  await page.getByLabel("OpenAI API key").fill("sk-rehearsal-key-for-open-bot-tests-0001");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("sk-…0001")).toBeVisible();
  await expect(page.getByTestId("fallback-status")).toContainText("Running on your ChatGPT plan");

  await createTeammate(page, uniqueName("Ava"));
  await sendMessage(page, "Say pong.");
  await waitForLastRun(page, ["completed"], 180_000);
  const run = page.getByTestId("run").last();
  await expect(run).toContainText("pong from the API key");
  await expect(run).toContainText("API key");
  await expect(run).toContainText("Your ChatGPT plan hit its limit");
  expect(requests.filter((url) => url.startsWith("/plan")).length).toBeGreaterThan(0);
  expect(requests.filter((url) => url.startsWith("/api")).length).toBeGreaterThan(0);

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
