import pg from "pg";
import { expect, test, type Page } from "./fixtures";
import { botIdOf, createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";
import { freshPostings, jobPortal, POSTINGS, trackerService } from "./job-scout-stand-ins";

const botd = process.env.BOTD_URL ?? "http://127.0.0.1:7070";
const botdToken = process.env.BOTD_TOKEN ?? "dev-botd-token-change-me";
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
});

// A test's connections would reach every teammate in the tests after it.
test.afterEach(() => pool.query("delete from connections where label like 'E2E %'"));
test.afterAll(() => pool.end());

async function botdPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${botd}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botdToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

/** A teammate's run identity, for driving its screen straight through botd. */
async function screenOf(page: Page) {
  const name = uniqueName("Tess");
  await createTeammate(page, name);
  const botId = await botIdOf(page, name);
  return { runId: `e2e-${botId}`, botId, botName: "E2E" };
}

test("the browser blocks job applications unless you have the screen", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const portal = await jobPortal();
  const run = await screenOf(page);
  try {
    // A page that keeps trying to submit an application.
    await botdPost("/computer/action", {
      run,
      action: { action: "open_url", url: `${portal.url}/auto-apply` },
    });
    // The action during which the page tried says so, so the bot knows to stop.
    const result = await botdPost<{ ok: boolean; blocked?: string[] }>("/computer/action", {
      run,
      action: { action: "wait", seconds: 3 },
    });
    expect(result.ok).toBe(true);
    expect(result.blocked).toContain("host.docker.internal");
    expect(portal.seen.applications).toEqual([]);

    // While you have the screen, it's yours to apply from.
    await botdPost("/lease/run/release", { runId: run.runId });
    await botdPost("/lease/user/take", { screenId: run.botId });
    await expect
      .poll(() => portal.seen.applications.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await botdPost("/lease/user/release", { screenId: run.botId });
  } finally {
    await botdPost("/lease/run/release", { runId: run.runId });
    await botdPost("/lease/user/release", { screenId: run.botId });
    await portal.stop();
  }
});

test("a bot reads the page in front as text and links", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const portal = await jobPortal();
  const run = await screenOf(page);
  try {
    await botdPost("/computer/action", {
      run,
      action: { action: "open_url", url: `${portal.url}/jobs/collections/recommended/` },
    });
    const feed = await botdPost<{
      ok: boolean;
      title: string;
      text: string;
      links: { text: string; href: string }[];
    }>("/computer/read", { run });
    expect(feed).toMatchObject({ ok: true, title: "Top job picks for you" });
    expect(feed.text).toContain("Senior Backend Engineer at Acme Payments");
    expect(feed.links.map((link) => link.href)).toContain(`${portal.url}/jobs/view/4022222222/`);

    // Part of the page, by selector, and a selector that matches nothing.
    const heading = await botdPost<{ ok: boolean; text: string }>("/computer/read", {
      run,
      selector: "h1",
    });
    expect(heading).toMatchObject({ ok: true, text: "Top job picks for you" });
    expect(await botdPost("/computer/read", { run, selector: "#nothing" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Nothing on the page matches"),
    });
  } finally {
    await botdPost("/lease/run/release", { runId: run.runId });
    await portal.stop();
  }
});

test("the Job scout template comes with its portal skills", async ({ page }) => {
  await page.goto("/bots/new");
  await page.getByRole("button", { name: "Job scout" }).click();
  await expect(page.getByLabel("Job", { exact: true })).toHaveValue("job scout");
  const starters = page.getByTestId("starter-automations");
  await expect(starters).toContainText("Collect jobs · Every day at 10:00 AM and 6:00 PM");
  await expect(starters).toContainText("Job digest · Every day at 7:00 PM");
  const name = uniqueName("Ivy");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create teammate" }).click();
  await page.waitForURL(/\/chats\//);

  await page.goto("/skills");
  for (const skill of ["collect-linkedin-jobs", "collect-naukri-jobs"]) {
    await expect(
      page
        .getByTestId("skill")
        .filter({ hasText: `/${skill}` })
        .filter({ hasText: name }),
    ).toHaveCount(1);
  }
});

async function connectTracker(page: Page, url: string, token?: string) {
  await page.goto("/settings#connections");
  const section = page.getByTestId("connections");
  await section.getByRole("button", { name: "Connect a service" }).click();
  const dialog = page.getByTestId("connection-dialog");
  await dialog.getByLabel("Name").fill("E2E Application tracker");
  await dialog.getByLabel("MCP address").fill(url);
  if (token) await dialog.getByLabel("Headers").fill(`Authorization: Bearer ${token}`);
  await dialog.getByTestId("connection-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(
    section
      .getByTestId("connection")
      .filter({ hasText: "E2E Application tracker" })
      .getByTestId("connection-test"),
  ).toContainText("Connected", { timeout: 60_000 });
}

function collectPrompt(portalUrl: string) {
  return `Run /collect-linkedin-jobs, but use the test portal at ${portalUrl} instead of https://www.linkedin.com (same paths), and wait only 1 second between postings.`;
}

test("@agent the Job Scout collects new postings into the tracker without applying", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const portal = await jobPortal();
  const tracker = await trackerService([POSTINGS[0]!.id]);
  try {
    await connectTracker(page, tracker.url);
    await page.goto("/bots/new");
    await page.getByRole("button", { name: "Job scout" }).click();
    await page.getByLabel("Name").fill(uniqueName("Ivy"));
    await page.getByRole("button", { name: "Create teammate" }).click();
    await page.waitForURL(/\/chats\//);

    await sendMessage(page, collectPrompt(portal.url));
    await waitForLastRun(page, ["completed"], 8 * 60_000);

    // Every posting on the feed was reported; only the new ones were opened and saved.
    expect(new Set(tracker.seen.reported)).toEqual(new Set(POSTINGS.map((posting) => posting.id)));
    expect(new Set(portal.seen.views)).toEqual(new Set([POSTINGS[1]!.id, POSTINGS[2]!.id]));
    const saved = new Map(tracker.seen.saved.map((posting) => [posting.postingId, posting]));
    expect([...saved.keys()].sort()).toEqual([POSTINGS[1]!.id, POSTINGS[2]!.id]);
    expect(saved.get(POSTINGS[1]!.id)!.pageText).toContain("payment services that move money");
    expect(portal.seen.applications).toEqual([]);
  } finally {
    await tracker.stop();
    await portal.stop();
  }
});

test("@agent the Job Scout asks you to sign in instead of signing in itself", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const portal = await jobPortal({ requireLogin: true });
  const tracker = await trackerService([]);
  try {
    await connectTracker(page, tracker.url);
    await page.goto("/bots/new");
    await page.getByRole("button", { name: "Job scout" }).click();
    await page.getByLabel("Name").fill(uniqueName("Ivy"));
    await page.getByRole("button", { name: "Create teammate" }).click();
    await page.waitForURL(/\/chats\//);

    await sendMessage(page, collectPrompt(portal.url));
    await expect(page.getByTestId("takeover-request").last()).toBeVisible({ timeout: 6 * 60_000 });
    expect(tracker.seen.saved).toEqual([]);
  } finally {
    await tracker.stop();
    await portal.stop();
  }
});

const realTracker = {
  url: process.env.E2E_TRACKER_MCP_URL,
  token: process.env.E2E_TRACKER_TOKEN,
};

/** Calls a tool on the real tracker the way open-bot's computer does, over MCP. */
async function trackerTool<T>(name: string, args: unknown): Promise<T> {
  const response = await fetch(realTracker.url!, {
    method: "POST",
    headers: { authorization: `Bearer ${realTracker.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0]!.text) as T;
}

// Against a real Application tracker (its MCP address and a token for a test user), the whole way:
// the Job Scout reads the stand-in portal, the tracker reads each posting and files it in the inbox.
test("@agent the Job Scout fills a real Application tracker's inbox", async ({ page }) => {
  test.skip(
    !realTracker.url || !realTracker.token,
    "Set E2E_TRACKER_MCP_URL and E2E_TRACKER_TOKEN",
  );
  test.setTimeout(12 * 60_000);
  const postings = freshPostings();
  const portal = await jobPortal({ postings });
  const startedAt = Date.now();
  try {
    await connectTracker(page, realTracker.url!, realTracker.token);
    const row = page
      .getByTestId("connections")
      .getByTestId("connection")
      .filter({ hasText: "E2E Application tracker" });
    // Codex's MCP client lists the tracker's tools.
    await expect(row.getByTestId("connection-test")).toContainText("4 tools");

    await page.goto("/bots/new");
    await page.getByRole("button", { name: "Job scout" }).click();
    await page.getByLabel("Name").fill(uniqueName("Ivy"));
    await page.getByRole("button", { name: "Create teammate" }).click();
    await page.waitForURL(/\/chats\//);
    await sendMessage(page, collectPrompt(portal.url));
    await waitForLastRun(page, ["completed"], 8 * 60_000);
    expect(portal.seen.applications).toEqual([]);

    // The tracker reads each posting with its own model and files a job for it.
    const companies = postings.map((posting) => posting.company);
    await expect
      .poll(
        async () => {
          const jobs = await trackerTool<{ company: string; role: string }[]>("list_jobs", {
            limit: 50,
          });
          return jobs
            .filter((job) => companies.includes(job.company))
            .map((job) => job.role)
            .sort();
        },
        { timeout: 3 * 60_000, intervals: [5_000] },
      )
      .toEqual(postings.map((posting) => posting.title).sort());
    const hours = Math.ceil((Date.now() - startedAt) / 3_600_000) + 1;
    const digest = await trackerTool<{ postingsCollected: number; postingsFailed: number }>(
      "job_digest",
      {
        sinceHours: hours,
      },
    );
    expect(digest.postingsCollected).toBeGreaterThanOrEqual(postings.length);
  } finally {
    await portal.stop();
  }
});
